//! Local inference AI provider
//!
//! Provides AI capabilities using a locally loaded model via llama.cpp.
//! No external services or API keys required.

use crate::services::ai::local::ModelTier;
use crate::services::ai::{AiProvider, AiProviderType, GeneratedCommitMessage, PromptLanguage};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Metadata about a loaded model, plumbed from the registry into inference.
#[derive(Debug, Clone)]
pub struct LoadedModelMeta {
    pub tier: ModelTier,
    pub architecture: String,
    pub context_length: u32,
}

/// Status of the local model
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalModelStatus {
    Unloaded,
    Loading,
    Ready,
    Error,
}

/// Trait for the inference engine (allows mocking in tests)
#[async_trait]
pub trait InferenceEngine: Send + Sync {
    /// Generate text given a prompt
    async fn generate(&self, prompt: &str, max_tokens: u32) -> Result<String, String>;
    /// Get the name of the loaded model
    fn model_name(&self) -> &str;
    /// Check if a model is loaded and ready
    fn is_ready(&self) -> bool;
    /// Get metadata about the loaded model (tier, architecture, context length)
    fn model_meta(&self) -> Option<&LoadedModelMeta> {
        None
    }
}

/// Format a prompt using the correct chat template for the model architecture.
fn format_prompt(arch: &str, system: &str, user: &str) -> String {
    match arch {
        "llama" => format!(
            "<|start_header_id|>system<|end_header_id|>\n\n{system}<|eot_id|>\
             <|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|>\
             <|start_header_id|>assistant<|end_header_id|>\n\n"
        ),
        "gemma3" => format!(
            "<start_of_turn>user\n{system}\n\n{user}<end_of_turn>\n\
             <start_of_turn>model\n"
        ),
        "phi" => format!(
            "<|system|>\n{system}<|end|>\n\
             <|user|>\n{user}<|end|>\n\
             <|assistant|>\n"
        ),
        "qwen2" | "qwen3" | "qwen" => format!(
            "<|im_start|>system\n{system}<|im_end|>\n\
             <|im_start|>user\n{user}<|im_end|>\n\
             <|im_start|>assistant\n"
        ),
        "mistral" => format!("[INST] {system}\n\n{user} [/INST]"),
        _ => format!("{system}\n\n{user}"),
    }
}

/// Per-tier pipeline configuration controlling token budgets and condensing behavior.
struct PipelineConfig {
    per_file_tokens: u32,
    summary_tokens: u32,
    max_body_bullets: usize,
    enable_condensing: bool,
    condensing_tokens: u32,
    condensing_threshold: usize,
    /// Token budget for the single-pass path, which must cover a summary line
    /// plus an optional short body in one response.
    single_pass_tokens: u32,
}

impl PipelineConfig {
    fn for_tier(tier: ModelTier) -> Self {
        match tier {
            ModelTier::UltraLight => Self {
                per_file_tokens: 25,
                summary_tokens: 30,
                max_body_bullets: 0,
                enable_condensing: false,
                condensing_tokens: 0,
                condensing_threshold: 0,
                // Enough for the conventional subject plus a short body; this
                // path is one call, so a slightly larger budget only costs the
                // tokens the model actually writes.
                single_pass_tokens: 140,
            },
            ModelTier::Pro => Self {
                per_file_tokens: 40,
                summary_tokens: 50,
                max_body_bullets: 12,
                enable_condensing: true,
                condensing_tokens: 200,
                condensing_threshold: 4,
                single_pass_tokens: 220,
            },
            _ => Self {
                per_file_tokens: 30,
                summary_tokens: 40,
                max_body_bullets: 10,
                enable_condensing: true,
                condensing_tokens: 150,
                condensing_threshold: 4,
                single_pass_tokens: 200,
            },
        }
    }
}

// System prompts for the commit message pipeline.
//
// Each has a Simplified-Chinese variant: the instructions themselves are in
// Chinese AND the prompt explicitly requires Chinese for every human-visible
// value, so a model that would otherwise answer in English from habit still
// produces a 简体中文 commit message. Tiers and structure markers stay ASCII.
const PERFILE_SYSTEM: &str = "In under 12 words, what is the purpose of this code change? \
    Use imperative mood (e.g. \"add\", \"fix\", \"update\", \"remove\"). \
    Output ONLY the description, no prefixes.";

const PERFILE_SYSTEM_ZH: &str = "用不超过 12 个字描述这个代码改动的目的。\
    使用祈使语气（例如\"添加\"、\"修复\"、\"更新\"、\"删除\"）。\
    只输出描述本身，不要任何前缀。必须使用简体中文。";

const CONDENSE_SYSTEM: &str = "Group these file changes into 4-6 bullet points. \
    Combine related changes. Each line must start with \"- \". Imperative mood. \
    Output ONLY the bullets.";

const CONDENSE_SYSTEM_ZH: &str = "将这些文件改动归纳为 4-6 条要点。\
    合并相关的改动。每行必须以 \"- \" 开头。使用祈使语气。\
    只输出要点本身。所有内容必须使用简体中文。";

const SUMMARY_SYSTEM_STANDARD: &str = "Synthesize ALL these changes into ONE conventional \
    commit summary. Do NOT repeat any single bullet. \
    Format: type(scope): description\n\
    Under 60 chars. Imperative mood. Output ONLY the summary line.";

const SUMMARY_SYSTEM_STANDARD_ZH: &str = "将所有这些改动综合成一条约定式提交摘要。\
    不要重复任何单条要点。格式：type(scope): 描述\n\
    不超过 60 个字符。使用祈使语气。只输出摘要行。所有人类可读内容必须使用简体中文。";

/// System prompt for the single-pass path, used when a change set is too big
/// for the per-file pipeline. It asks for the whole change set in one message,
/// with an optional short bullet body.
///
/// The format block and the "never list file names" rule are load-bearing: a
/// small model given 134 filenames summarised the FILE LIST as its answer on
/// this exact path, and the parser (then) put that 768-character line in the
/// summary while the real subject landed in the body. Spelling out the required
/// shape and forbidding an echo of the input keeps the answer in one piece.
const SINGLE_PASS_SYSTEM: &str = "Write ONE git commit message for ALL the following \
    file changes together. Follow conventional commit format: type(scope): description. \
    Types: feat, fix, docs, style, refactor, test, chore, perf, build, ci. \
    Output format (follow it exactly):\n\
    type(scope): description\n\
    \n\
    - optional bullet\n\
    - optional bullet\n\
    Rules: the FIRST line is the commit subject; summarize the whole change set, not \
    individual files; summary under 60 chars; imperative mood; no trailing period; \
    never list file names or paths; never repeat or quote the diff; no preamble, no \
    explanation; optionally add a blank line and 2-5 \"- \" bullets for the notable \
    groups of changes; output ONLY the commit message.";

const SINGLE_PASS_SYSTEM_ZH: &str = "为下面所有文件改动组成的一个改动集合撰写一条 git 提交信息。\
    使用约定式提交格式：type(scope): 描述。\
    类型：feat, fix, docs, style, refactor, test, chore, perf, build, ci。\
    输出格式（严格照做）：\n\
    type(scope): 描述\n\
    \n\
    - 可选要点\n\
    - 可选要点\n\
    规则：第一行是提交摘要；概括整个改动集合，而不是逐个文件；摘要不超过 60 个字符；\
    使用祈使语气；摘要结尾不要加句号；不要列出文件名或路径；不要重复或引用 diff 内容；\
    不要任何前言或解释；可以选择空一行后用 2-5 条 \"- \" 开头的要点列出主要分组改动；\
    只输出提交信息本身。所有人类可读内容（摘要和正文）必须使用简体中文。";

/// Prompt used for the post-load warm-up. Deliberately tiny and
/// language-neutral: it only has to make llama.cpp evaluate a prompt and take
/// one decode step.
const WARM_UP_SYSTEM: &str = "Reply with OK.";
const WARM_UP_TEXT: &str = "ok";
const WARM_UP_TOKENS: u32 = 1;

/// Above this many relevant files the per-file pipeline is replaced by a
/// single bounded model call: 134 staged files cost 134+ generations (minutes
/// on a laptop) through the per-file path, and the extra passes add little for
/// changes that are mostly mechanical.
const MAX_PER_FILE_PASSES: usize = 6;

/// Total byte budget for the condensed diff in the single-pass prompt. Small
/// local models have a 4-8K token context; ~4KB of diff leaves room for the
/// instructions and the answer without truncating the prompt mid-file.
const SINGLE_PASS_DIFF_BUDGET_BYTES: usize = 4096;

/// Never spend less than this on a single file's content in the condensed
/// diff — below it even a filename-sized snippet is useless.
const SINGLE_PASS_MIN_FILE_BYTES: usize = 96;

/// Upper bound per file: the budget is split evenly, but one huge file should
/// not eat the whole prompt when there are only a handful of files.
const SINGLE_PASS_MAX_FILE_BYTES: usize = 800;

/// At most this many files are shown to the model in the single-pass prompt.
///
/// The budget could fit ~25 file headers, but a small model handed 25 paths
/// tends to echo the list as its answer. Ten representative files give it
/// enough context while keeping the amount of copyable path text small; the
/// remainder is reported as a count.
const SINGLE_PASS_MAX_FILES: usize = 10;

/// Token budget for the repair call. A Chinese conventional subject can need
/// close to 100 tokens, and the tier summary budgets (30-50) are too small for
/// a rewrite.
const REPAIR_TOKENS: u32 = 110;

/// Prompt that rewrites a draft which is really an echoed file list into a
/// proper commit message.
///
/// Small local models sometimes answer with the changed-file list (optionally
/// with the message glued onto the last path) instead of a commit subject. The
/// draft is short, so one focused rewrite almost always follows the format.
const REPAIR_SYSTEM: &str = "Rewrite the following draft as ONE concise git commit message. \
    First line format: type(scope): description. Types: feat, fix, docs, style, refactor, \
    test, chore, perf, build, ci. Rules: do not include file names or paths, do not use \
    bullet points, keep it under 60 characters, imperative mood, no trailing period. \
    Output ONLY the commit message.";

const REPAIR_SYSTEM_ZH: &str = "把下面这段草稿改写为一条简洁的 git 提交信息。\
    第一行格式：type(scope): 描述。类型：feat, fix, docs, style, refactor, test, chore, perf, build, ci。\
    规则：不要包含文件名或路径，不要使用要点符号，不超过 60 个字符，使用祈使语气，结尾不加句号。\
    只输出提交信息本身。所有人类可读内容必须使用简体中文。";

/// The repair prompt for `language`.
fn repair_system(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        REPAIR_SYSTEM_ZH
    } else {
        REPAIR_SYSTEM
    }
}

/// The per-file description prompt for `language`.
fn perfile_system(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        PERFILE_SYSTEM_ZH
    } else {
        PERFILE_SYSTEM
    }
}

/// The condensing prompt for `language`.
fn condense_system(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        CONDENSE_SYSTEM_ZH
    } else {
        CONDENSE_SYSTEM
    }
}

/// The summary-line prompt for `language`.
fn summary_system(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        SUMMARY_SYSTEM_STANDARD_ZH
    } else {
        SUMMARY_SYSTEM_STANDARD
    }
}

/// The single-pass prompt for `language`.
fn single_pass_system(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        SINGLE_PASS_SYSTEM_ZH
    } else {
        SINGLE_PASS_SYSTEM
    }
}

/// Local inference provider implementation
///
/// All fields use Arc, so cloning shares state across instances.
#[derive(Clone)]
pub struct LocalInferenceProvider {
    engine: Arc<RwLock<Option<Box<dyn InferenceEngine>>>>,
    status: Arc<RwLock<LocalModelStatus>>,
    model_name: Arc<RwLock<Option<String>>>,
}

impl Default for LocalInferenceProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalInferenceProvider {
    pub fn new() -> Self {
        Self {
            engine: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(LocalModelStatus::Unloaded)),
            model_name: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the inference engine (called when a model is loaded)
    pub async fn set_engine(&self, engine: Box<dyn InferenceEngine>) {
        let name = engine.model_name().to_string();
        *self.engine.write().await = Some(engine);
        *self.status.write().await = LocalModelStatus::Ready;
        *self.model_name.write().await = Some(name);
    }

    /// Clear the engine (called when model is unloaded)
    pub async fn clear_engine(&self) {
        *self.engine.write().await = None;
        *self.status.write().await = LocalModelStatus::Unloaded;
        *self.model_name.write().await = None;
    }

    /// Get the current model status
    pub async fn get_status(&self) -> LocalModelStatus {
        *self.status.read().await
    }

    /// Set status to loading (called during model load)
    pub async fn set_loading(&self) {
        *self.status.write().await = LocalModelStatus::Loading;
    }

    /// Set status to error
    pub async fn set_error(&self) {
        *self.status.write().await = LocalModelStatus::Error;
    }

    /// Get the loaded model name
    pub async fn get_model_name(&self) -> Option<String> {
        self.model_name.read().await.clone()
    }

    /// Best-effort warm-up of the loaded engine.
    ///
    /// The first generation after a model load pays for llama.cpp's kernel and
    /// context setup, which is a noticeable part of first-token latency for the
    /// small token budgets the commit pipeline uses. Running one tiny
    /// generation immediately after loading moves that cost off the user's
    /// first real request. Failure is not an error condition anywhere: a
    /// warm-up that fails only means the first request is as slow as before.
    pub async fn warm_up(&self) -> Result<(), String> {
        let engine = self.engine.read().await;
        let engine = match engine.as_ref() {
            Some(engine) => engine,
            None => return Ok(()),
        };
        let arch = engine
            .model_meta()
            .map(|m| m.architecture.as_str())
            .unwrap_or("llama");
        // One token is enough to trigger prompt evaluation and the first
        // decode step; anything more only delays the UI for no benefit.
        let prompt = format_prompt(arch, WARM_UP_SYSTEM, WARM_UP_TEXT);
        engine.generate(&prompt, WARM_UP_TOKENS).await.map(|_| ())
    }
}

#[async_trait]
impl AiProvider for LocalInferenceProvider {
    fn provider_type(&self) -> AiProviderType {
        AiProviderType::LocalInference
    }

    fn name(&self) -> &str {
        "Local AI (Embedded)"
    }

    async fn is_available(&self) -> bool {
        let engine = self.engine.read().await;
        engine.as_ref().is_some_and(|e| e.is_ready())
    }

    async fn list_models(&self) -> Result<Vec<String>, String> {
        let name = self.model_name.read().await;
        match name.as_ref() {
            Some(n) => Ok(vec![n.clone()]),
            None => Ok(vec![]),
        }
    }

    async fn generate_commit_message(
        &self,
        diff: &str,
        _model: Option<&str>,
        language: PromptLanguage,
    ) -> Result<GeneratedCommitMessage, String> {
        let engine = self.engine.read().await;
        let engine = engine
            .as_ref()
            .ok_or("No model loaded. Please download and load a model in Settings > Local AI.")?;

        // Get model metadata for architecture-aware prompting and tier-based pipeline
        let meta = engine.model_meta();
        let arch = meta.map(|m| m.architecture.as_str()).unwrap_or("llama");
        let tier = meta.map(|m| m.tier).unwrap_or(ModelTier::Standard);
        let config = PipelineConfig::for_tier(tier);

        let file_diffs = extract_file_diffs(diff);

        if file_diffs.is_empty() {
            return Err("No changes to summarize".to_string());
        }

        // Drop files that say nothing about the intent of the change — lockfiles,
        // build output, minified assets, binaries. On the staged set that made
        // the local model crawl, most of the file count is usually lockfile
        // churn, so filtering is itself a large speed-up. If EVERY file is
        // noise, keep the unfiltered set: an empty summary is worse than a
        // summary of lockfiles.
        let file_diffs = filter_noise_files(file_diffs);
        let file_paths: Vec<&str> = file_diffs.iter().map(|f| f.path.as_str()).collect();

        // Large change sets go through ONE bounded model call instead of one
        // call per file. A 134-file stage used to mean 134+ sequential
        // generations (minutes on a laptop); the per-file path stays for small
        // sets, where it produces better bullets.
        if file_diffs.len() > MAX_PER_FILE_PASSES {
            return single_pass_commit_message(
                engine.as_ref(),
                arch,
                &config,
                &file_diffs,
                language,
            )
            .await;
        }

        // Multi-pass path for small change sets:
        // Pass 1: Summarize every file's diff individually
        // Pass 2: If many summaries, condense into grouped higher-level bullets
        // Pass 3: Generate the summary line from the final bullet list

        // Pass 1: Summarize every file (~1-2s per file on Apple Silicon)
        let mut file_summaries = Vec::new();
        for file_diff in &file_diffs {
            let user_content = format!("File: {}\n{}", file_diff.path, file_diff.content);
            let prompt = format_prompt(arch, perfile_system(language), &user_content);
            match engine.generate(&prompt, config.per_file_tokens).await {
                Ok(desc) => {
                    let desc = clean_bullet_text(&desc);
                    if !desc.is_empty() {
                        file_summaries.push(format!("- {}", desc));
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to summarize {}: {e}", file_diff.path);
                }
            }
        }

        if file_summaries.is_empty() {
            return Err("No changes to summarize".to_string());
        }

        tracing::debug!(
            "Per-file summaries ({}):\n{}",
            file_summaries.len(),
            file_summaries.join("\n")
        );

        // Deduplicate near-identical summaries and cap the total.
        // UltraLight models produce short, generic summaries that trigger false
        // positives in dedup — skip it entirely and just cap the list.
        // Standard models get light dedup (cap only, no word-overlap checks)
        // since the condensing pass handles grouping.
        let mut body_bullets = match tier {
            ModelTier::UltraLight => file_summaries,
            _ => {
                let cap = if config.max_body_bullets == 0 {
                    usize::MAX
                } else {
                    config.max_body_bullets
                };
                if file_summaries.len() > cap {
                    file_summaries.into_iter().take(cap).collect()
                } else {
                    file_summaries
                }
            }
        };

        // Pass 2: Condense (Standard tier only, when above threshold)
        if config.enable_condensing && body_bullets.len() > config.condensing_threshold {
            let raw_list = body_bullets.join("\n");
            let prompt = format_prompt(arch, condense_system(language), &raw_list);

            match engine.generate(&prompt, config.condensing_tokens).await {
                Ok(response) => {
                    let condensed: Vec<String> = response
                        .lines()
                        .map(|l| l.trim())
                        .filter(|l| l.starts_with('-') || l.starts_with('*'))
                        .map(|l| {
                            let s = l
                                .strip_prefix("- ")
                                .or_else(|| l.strip_prefix("* "))
                                .unwrap_or(l)
                                .trim();
                            format!("- {s}")
                        })
                        .filter(|l| l.len() > 2)
                        .collect();

                    // Require at least 3 bullets to accept condensing, otherwise keep originals
                    if condensed.len() >= 3 {
                        tracing::debug!(
                            "Condensed {} bullets to {}",
                            body_bullets.len(),
                            condensed.len()
                        );
                        body_bullets = condensed;
                    } else {
                        tracing::debug!(
                            "Condensing returned {} bullets (< 3), keeping originals",
                            condensed.len()
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!("Condensing pass failed: {e}, keeping original bullets");
                }
            }
        }

        let changes_text = body_bullets.join("\n");
        tracing::debug!(
            "After dedup: {} bullets (tier={:?}):\n{}",
            body_bullets.len(),
            tier,
            changes_text
        );

        // Pass 3: Generate the summary line
        let summary = if tier == ModelTier::UltraLight {
            // 1B models can't synthesize — build summary heuristically from bullets + file paths
            build_summary_from_bullets(&body_bullets, &file_paths)
        } else {
            let prompt = format_prompt(arch, summary_system(language), &changes_text);
            let response = engine.generate(&prompt, config.summary_tokens).await?;
            tracing::debug!("Raw summary response:\n{response}");
            clean_summary_line(&response)
        };

        // Use the bullet list as the commit body (only if 2+ bullets add value)
        let body = if body_bullets.len() >= 2 {
            tracing::debug!("Including body with {} bullets", body_bullets.len());
            Some(changes_text)
        } else {
            tracing::debug!(
                "Omitting body ({} bullet(s) < 2 threshold)",
                body_bullets.len()
            );
            None
        };

        Ok(GeneratedCommitMessage { summary, body })
    }

    async fn generate_text(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        _model: Option<&str>,
        max_tokens: Option<u32>,
    ) -> Result<String, String> {
        let engine = self.engine.read().await;
        let engine = engine
            .as_ref()
            .ok_or("No model loaded. Please download and load a model in Settings > Local AI.")?;

        let arch = engine
            .model_meta()
            .map(|m| m.architecture.as_str())
            .unwrap_or("llama");
        let prompt = format_prompt(arch, system_prompt, user_prompt);
        engine.generate(&prompt, max_tokens.unwrap_or(512)).await
    }
}

/// Extract per-file diffs from a unified diff string.
///
/// Each file gets its own diff chunk (added/removed lines with some context)
/// so it can be independently summarized by the model.
fn extract_file_diffs(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();
    // Track the path from "diff --git" for binary files that lack "+++ b/" lines
    let mut pending_diff_path: Option<String> = None;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // Extract path from "diff --git a/foo b/foo" — take the "b/" part
            if let Some(b_path) = rest.split(" b/").last() {
                pending_diff_path = Some(b_path.to_string());
            }
            continue;
        } else if let Some(path) = line.strip_prefix("+++ b/") {
            // Flush previous file
            if let Some(prev) = current_path.take() {
                files.push(FileDiff {
                    path: prev,
                    content: std::mem::take(&mut current_lines).join("\n"),
                });
            }
            current_path = Some(path.to_string());
            pending_diff_path = None;
        } else if line.contains("Binary files") || line.contains("GIT binary patch") {
            // Binary file — use the path from the preceding "diff --git" line
            if let Some(path) = pending_diff_path.take() {
                // Flush any previous file first
                if let Some(prev) = current_path.take() {
                    files.push(FileDiff {
                        path: prev,
                        content: std::mem::take(&mut current_lines).join("\n"),
                    });
                }
                files.push(FileDiff {
                    path,
                    content: "[binary file modified]".to_string(),
                });
            }
        } else if line.starts_with("--- ") {
            continue;
        } else if current_path.is_some() {
            // Keep +/- lines, @@ headers, and surrounding context lines
            // so the model can understand what the changed code relates to
            current_lines.push(line.to_string());
        }
    }

    // Flush last file
    if let Some(path) = current_path {
        files.push(FileDiff {
            path,
            content: current_lines.join("\n"),
        });
    }

    // Truncate each file's content to keep batches within model context.
    // Each batch has ~3 files, and the model has ~8192 tokens (~32K chars).
    // Budget ~2000 chars per file to leave room for the prompt template.
    let max_bytes_per_file = if files.len() > 10 { 1500 } else { 2500 };
    for file in &mut files {
        if file.content.len() > max_bytes_per_file {
            // On a char boundary: the budget is a BYTE count, and slicing a
            // &str mid-character panics — which killed the whole local-model
            // summary for any diff carrying non-ASCII text.
            file.content =
                crate::services::ai::truncate_at_char_boundary(&file.content, max_bytes_per_file)
                    .to_string();
            file.content.push_str("\n[truncated]");
        }
    }

    files
}

#[derive(Debug, Clone)]
struct FileDiff {
    path: String,
    content: String,
}

/// File names that carry no signal about the intent of a change.
///
/// A lockfile can be thousands of changed lines of machine-owned JSON, a
/// generated bundle or a binary asset says nothing a commit message can use,
/// and on a large stage they are usually the majority of the file count. The
/// per-file pipeline spent one model call on each of them, and the single-pass
/// prompt has a byte budget they would otherwise consume.
fn is_noise_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);

    // Lockfiles: huge, machine-owned, and no hint about what changed.
    const LOCKFILES: &[&str] = &[
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "cargo.lock",
        "poetry.lock",
        "pipfile.lock",
        "composer.lock",
        "gemfile.lock",
        "go.sum",
    ];
    if LOCKFILES.contains(&file_name) {
        return true;
    }

    // Generated / vendored output directories, matched as path SEGMENTS so a
    // source file whose name merely contains "build" is not caught.
    const NOISE_SEGMENTS: &[&str] = &[
        "dist",
        "build",
        "node_modules",
        "vendor",
        "target",
        ".next",
        ".nuxt",
        ".cache",
        "coverage",
    ];
    if lower
        .split('/')
        .any(|segment| NOISE_SEGMENTS.contains(&segment))
    {
        return true;
    }

    // Minified bundles and source maps.
    if file_name.ends_with(".min.js")
        || file_name.ends_with(".min.css")
        || file_name.ends_with(".min.mjs")
        || file_name.ends_with(".map")
    {
        return true;
    }

    // Binaries and other non-text assets.
    const BINARY_EXTENSIONS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "bmp", "tiff", "pdf", "psd", "zip",
        "gz", "tar", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "exe", "dll", "so", "dylib",
        "a", "o", "obj", "lib", "pdb", "class", "jar", "wasm", "mp3", "wav", "ogg", "flac", "mp4",
        "mov", "avi", "mkv", "webm", "ttf", "otf", "woff", "woff2", "eot",
    ];
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or("");
    BINARY_EXTENSIONS.contains(&extension)
}

/// Remove noise files from the change set.
///
/// Falls back to the unfiltered set when filtering would leave nothing: a
/// stage made of nothing but a regenerated lockfile produces an empty summary
/// otherwise, which is a worse answer than summarizing the lockfile.
fn filter_noise_files(files: Vec<FileDiff>) -> Vec<FileDiff> {
    let kept: Vec<FileDiff> = files
        .iter()
        .filter(|file| !is_noise_file(&file.path))
        .cloned()
        .collect();
    if kept.is_empty() {
        files
    } else {
        kept
    }
}

/// Render the bounded multi-file diff used by the single-pass path.
///
/// Only the [`SINGLE_PASS_MAX_FILES`] largest diffs are shown — representative
/// content with a small amount of copyable path text — and every included file
/// gets a header plus as much of its diff as its share of
/// [`SINGLE_PASS_DIFF_BUDGET_BYTES`] allows. The omitted count is stated so the
/// model knows the change set is bigger than what it can see. The budget is a
/// BYTE count and diff content is routinely non-ASCII, so every cut goes
/// through the char-boundary-safe truncation.
fn build_single_pass_diff(files: &[FileDiff], language: PromptLanguage) -> String {
    let total = files.len();

    // Largest diffs first: they carry the most intent, and showing only a
    // representative slice keeps the echoed-path surface small.
    let mut ordered: Vec<&FileDiff> = files.iter().collect();
    ordered.sort_by_key(|file| std::cmp::Reverse(file.content.len()));
    ordered.truncate(SINGLE_PASS_MAX_FILES);
    ordered.sort_by(|a, b| a.path.cmp(&b.path));

    let per_file = (SINGLE_PASS_DIFF_BUDGET_BYTES / ordered.len().max(1))
        .clamp(SINGLE_PASS_MIN_FILE_BYTES, SINGLE_PASS_MAX_FILE_BYTES);

    let mut out = String::new();
    // A non-path first line puts the model into "answer the task" mode instead
    // of "continue the file list" mode.
    if language.is_zh() {
        out.push_str(&format!("共 {total} 个文件改动（仅展示代表性差异）：\n\n"));
    } else {
        out.push_str(&format!(
            "{total} files changed (representative diffs shown):\n\n"
        ));
    }

    let mut included = 0;
    for file in &ordered {
        let header = format!("### {}\n", file.path);
        if included > 0 && out.len() + header.len() >= SINGLE_PASS_DIFF_BUDGET_BYTES {
            break;
        }
        out.push_str(&header);

        let remaining = SINGLE_PASS_DIFF_BUDGET_BYTES.saturating_sub(out.len());
        let content_budget = per_file.min(remaining);
        let content = crate::services::ai::truncate_at_char_boundary(&file.content, content_budget);
        out.push_str(content);
        if content.len() < file.content.len() {
            out.push_str("\n[truncated]");
        }
        out.push('\n');
        included += 1;
    }

    let omitted = total.saturating_sub(included);
    if omitted > 0 {
        if language.is_zh() {
            out.push_str(&format!("…… 另有 {omitted} 个文件未展示\n"));
        } else {
            out.push_str(&format!("... and {omitted} more files not shown\n"));
        }
    }

    out
}

/// Whether a "summary" is really an echoed file list rather than a subject.
///
/// A real commit subject is short. A file-list echo is long and dense with path
/// separators and item commas — that is the shape the embedded model produced
/// (917 characters, mostly `path, path, …`), and it must not reach the summary
/// box even when the model never wrote a proper subject.
fn summary_needs_repair(summary: &str) -> bool {
    let trimmed = summary.trim();
    if looks_like_single_file_path(trimmed) {
        return true;
    }
    if trimmed.chars().count() <= 100 {
        return false;
    }
    let slashes = trimmed.matches('/').count();
    let separators = trimmed.matches(',').count() + trimmed.matches('，').count();
    // Path density is the signal, not commas on their own: a long Chinese
    // sentence legitimately contains several full-width commas while a file
    // list is dense with `/`. Requiring both (or a very high slash count)
    // keeps ordinary prose from being treated as an echo.
    (slashes >= 3 && separators >= 2) || slashes >= 5
}

/// Whether the whole answer is a single file path (e.g. `docs/localisation.md`).
///
/// Small models sometimes answer a summarisation task with just the "most
/// important" changed file. It is short, so the length check would let it
/// through, but it is not a commit message.
fn looks_like_single_file_path(text: &str) -> bool {
    if text.is_empty() || text.chars().count() > 160 {
        return false;
    }
    // A topic containing a path is still prose ("update docs/x.md"); when spaces
    // appear the answer is treated as a sentence, not a path.
    if text.chars().any(char::is_whitespace) {
        return false;
    }
    if !text.contains('/') {
        return false;
    }
    match text.rsplit('.').next() {
        Some(extension) => {
            !extension.is_empty()
                && extension.len() <= 5
                && extension.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Rewrite `draft` into a commit message with one focused model call.
///
/// Returns `None` when the model still does not produce something usable.
async fn repair_commit_message(
    engine: &dyn InferenceEngine,
    arch: &str,
    draft: &str,
    language: PromptLanguage,
) -> Option<GeneratedCommitMessage> {
    let prompt = format_prompt(arch, repair_system(language), draft);
    let response = engine.generate(&prompt, REPAIR_TOKENS).await.ok()?;
    let repaired = parse_commit_message(&response).ok()?;
    let summary = repaired.summary.trim();
    if summary.is_empty() || summary_needs_repair(summary) {
        return None;
    }
    Some(repaired)
}

/// Last-resort commit message when the model produced only file-list noise.
///
/// Deterministic and honest beats putting an unusable blob in the summary: the
/// user gets a valid conventional subject naming the scope and size, and can
/// edit it. This only runs after the single call AND the repair call both
/// failed to produce something usable.
fn fallback_single_pass_message(
    files: &[FileDiff],
    language: PromptLanguage,
) -> GeneratedCommitMessage {
    let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    let scope = derive_scope(&paths);

    // Additions vs deletions is the only signal left once the model failed;
    // a change set that is overwhelmingly additions is most likely a feature.
    let mut added = 0usize;
    let mut removed = 0usize;
    for file in files {
        for line in file.content.lines() {
            if line.starts_with('+') && !line.starts_with("+++") {
                added += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                removed += 1;
            }
        }
    }
    let commit_type = if added > removed.saturating_mul(3) && added > 10 {
        "feat"
    } else if removed > added.saturating_mul(3) && removed > 10 {
        "refactor"
    } else {
        "chore"
    };

    let count = files.len();
    let summary = match (language.is_zh(), scope.is_empty()) {
        (true, true) => format!("{commit_type}: 更新 {count} 个文件"),
        (true, false) => format!("{commit_type}({scope}): 更新 {count} 个文件"),
        (false, true) => format!("{commit_type}: update {count} files"),
        (false, false) => format!("{commit_type}({scope}): update {count} files"),
    };

    GeneratedCommitMessage {
        summary,
        body: None,
    }
}

/// Generate a commit message for a large change set in ONE model call, with a
/// focused repair call if the model answered with a file list instead.
async fn single_pass_commit_message(
    engine: &dyn InferenceEngine,
    arch: &str,
    config: &PipelineConfig,
    files: &[FileDiff],
    language: PromptLanguage,
) -> Result<GeneratedCommitMessage, String> {
    let condensed = build_single_pass_diff(files, language);
    tracing::debug!(
        "Single-pass commit message for {} relevant files in {} bytes",
        files.len(),
        condensed.len()
    );

    // A closing instruction, right before the answer, restates the output shape.
    // Models follow the instruction at the end of the prompt more reliably than
    // one that sits above a page of diff.
    let cue = if language.is_zh() {
        "\n\n现在只输出提交信息本身，不要重复任何文件名或路径。"
    } else {
        "\n\nNow output only the commit message. Do not repeat any file name or path."
    };
    let user_prompt = format!("{condensed}{cue}");
    let prompt = format_prompt(arch, single_pass_system(language), &user_prompt);
    let response = engine.generate(&prompt, config.single_pass_tokens).await?;
    tracing::debug!("Raw single-pass response:\n{response}");

    let draft = match parse_commit_message(&response) {
        Ok(message) if !message.summary.trim().is_empty() => message,
        // A small model occasionally answers in prose the parser cannot make a
        // message of. A best-effort first line still beats failing the command
        // after the single call already ran.
        _ => GeneratedCommitMessage {
            summary: clean_summary_line(&response),
            body: None,
        },
    };

    if !summary_needs_repair(&draft.summary) {
        return Ok(draft);
    }

    tracing::warn!(
        "Single-pass answer looks like an echoed file list, repairing: {:?}",
        draft.summary
    );
    if let Some(repaired) = repair_commit_message(engine, arch, &draft.summary, language).await {
        return Ok(repaired);
    }

    Ok(fallback_single_pass_message(files, language))
}

/// Clean a model response into a single bullet description.
///
/// Strips preamble like "Here is the description:", bullet markers, quotes,
/// and takes only the first meaningful line.
fn clean_bullet_text(text: &str) -> String {
    let text = text.trim();

    // Take only the first non-empty, meaningful line
    let line = text
        .lines()
        .map(|l| l.trim())
        .find(|l| {
            !l.is_empty()
                && !l.to_lowercase().starts_with("here is")
                && !l.to_lowercase().starts_with("the purpose")
                && !l.to_lowercase().starts_with("this code")
                && !l.to_lowercase().starts_with("file:")
                && !l.starts_with("@@")
                && !l.starts_with("diff ")
                && !l.starts_with("+++")
                && !l.starts_with("---")
                && !l.ends_with(':')
        })
        .unwrap_or("");

    // Strip bullet markers, quotes, backticks
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line);
    let line = line.trim_matches('"').trim_matches('\'').trim_matches('`');

    // Reject single-word responses and raw diff artifacts
    let word_count = line.split_whitespace().count();
    if word_count < 2 || line.starts_with("@@") || line.contains("<|") {
        return String::new();
    }

    // Capitalize first letter
    let mut chars = line.chars();
    match chars.next() {
        Some(c) => {
            let first = c.to_uppercase().to_string();
            format!("{first}{}", chars.as_str())
        }
        None => String::new(),
    }
}

/// Extract and clean the first meaningful line from a model's summary response.
///
/// Strips leading bullet markers, quotes, backticks, and preamble so we get
/// a clean conventional-commit summary line.
fn clean_summary_line(response: &str) -> String {
    let line = response
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("chore: update code");

    // Strip leading bullet markers
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line);

    // Strip surrounding quotes and backticks
    let line = line
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('`')
        .trim();

    if line.is_empty() {
        "chore: update code".to_string()
    } else {
        line.to_string()
    }
}

/// Build a conventional commit summary heuristically from per-file bullets and paths.
///
/// Used for UltraLight (1B) models that can't synthesize a summary from bullets.
/// Determines the commit type from bullet text, scope from file paths, and
/// picks the most representative bullet as the description.
fn build_summary_from_bullets(bullets: &[String], file_paths: &[&str]) -> String {
    // Count action verbs to determine commit type
    let bullet_text: Vec<&str> = bullets
        .iter()
        .map(|b| b.strip_prefix("- ").unwrap_or(b))
        .collect();

    let (mut adds, mut fixes, mut updates, mut removes) = (0u32, 0u32, 0u32, 0u32);
    for text in &bullet_text {
        let lower = text.to_lowercase();
        // Chinese bullets (简体中文 prompt) carry the same intent with no word
        // spacing, so they are matched by prefix on the characters themselves.
        if lower.starts_with("add")
            || lower.starts_with("implement")
            || lower.starts_with("create")
            || lower.starts_with("添加")
            || lower.starts_with("新增")
            || lower.starts_with("实现")
            || lower.starts_with("创建")
        {
            adds += 1;
        } else if lower.starts_with("fix")
            || lower.starts_with("resolve")
            || lower.starts_with("修复")
            || lower.starts_with("解决")
        {
            fixes += 1;
        } else if lower.starts_with("update")
            || lower.starts_with("change")
            || lower.starts_with("modify")
            || lower.starts_with("refactor")
            || lower.starts_with("更新")
            || lower.starts_with("修改")
            || lower.starts_with("重构")
        {
            updates += 1;
        } else if lower.starts_with("remove")
            || lower.starts_with("delete")
            || lower.starts_with("删除")
            || lower.starts_with("移除")
        {
            removes += 1;
        } else {
            updates += 1; // default
        }
    }

    let commit_type = if fixes > adds && fixes > updates {
        "fix"
    } else if adds >= updates && adds >= removes {
        "feat"
    } else if removes > adds && removes > updates {
        "refactor"
    } else {
        "chore"
    };

    // Derive scope from file paths — find the most common top-level directory
    let scope = derive_scope(file_paths);

    // Pick the most descriptive bullet (longest that isn't too long)
    let description = bullet_text
        .iter()
        .filter(|b| b.len() >= 10 && b.len() <= 60)
        .max_by_key(|b| b.len())
        .or(bullet_text.first())
        .map(|b| {
            // Lowercase the first char for conventional commit style
            let mut chars = b.chars();
            match chars.next() {
                Some(c) => format!("{}{}", c.to_lowercase(), chars.as_str()),
                None => b.to_string(),
            }
        })
        .unwrap_or_else(|| "update code".to_string());

    // Strip trailing period
    let description = description.trim_end_matches('.');

    let summary = if scope.is_empty() {
        format!("{commit_type}: {description}")
    } else {
        format!("{commit_type}({scope}): {description}")
    };

    // Truncate to 72 CHARS. This used to be a byte slice (`&summary[..69]`),
    // which panics whenever the cut lands inside a multi-byte character — and
    // Chinese, at three bytes per character, lands there almost always.
    if summary.chars().count() > 72 {
        let truncated: String = summary.chars().take(69).collect();
        format!("{truncated}...")
    } else {
        summary
    }
}

/// Derive a scope name from file paths by finding the most common directory.
fn derive_scope(paths: &[&str]) -> String {
    if paths.is_empty() {
        return String::new();
    }

    // Count occurrences of each top-level meaningful directory segment
    let mut dir_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for path in paths {
        // Skip common prefixes and find the meaningful directory
        let segments: Vec<&str> = path.split('/').collect();
        // Look for a meaningful segment (skip "src", "src-tauri", "lib", etc.)
        let scope_segment = segments
            .iter()
            .find(|s| {
                !matches!(
                    **s,
                    "src"
                        | "src-tauri"
                        | "lib"
                        | "app"
                        | "tests"
                        | "test"
                        | "e2e"
                        | "components"
                        | "services"
                        | "commands"
                        | "models"
                        | "utils"
                        | "fixtures"
                        | "pages"
                        | "__tests__"
                )
            })
            .or(segments.get(1).or(segments.first()));

        if let Some(seg) = scope_segment {
            // Strip file extension if it's a file
            let name = if seg.contains('.') {
                seg.split('.').next().unwrap_or(seg)
            } else {
                seg
            };
            if !name.is_empty() {
                *dir_counts.entry(name).or_default() += 1;
            }
        }
    }

    // Return the most common segment if it covers >40% of files
    dir_counts
        .iter()
        .max_by_key(|(_, count)| *count)
        .filter(|(_, count)| **count * 100 / paths.len() > 40)
        .map(|(name, _)| name.to_string())
        .unwrap_or_default()
}

/// The conventional-commit types a model may start a subject with.
const CONVENTIONAL_COMMIT_TYPES: &[&str] = &[
    "feat", "fix", "docs", "style", "refactor", "test", "chore", "perf", "build", "ci", "revert",
];

/// Whether `line` starts a conventional-commit subject.
///
/// The type token must be followed by a scope, the breaking-change marker or a
/// colon — merely STARTING with the word is not enough. That distinction is the
/// bug this fixes: `docs/localisation.md, e2e/tests/…` (the echoed file list a
/// small model produced for a 134-file change set) starts with `docs`, so the
/// old prefix check treated it as a `docs:` commit, making a 768-character file
/// list the "summary" while the real subject went into the body.
///
/// Both the ASCII colon models usually emit and the full-width colon Chinese
/// output sometimes produces are accepted.
fn is_conventional_commit_line(line: &str) -> bool {
    let trimmed = line.trim();
    // Strip wrapping the model likes to add around a commit line.
    let trimmed = trimmed
        .strip_prefix('"')
        .or_else(|| trimmed.strip_prefix('\''))
        .or_else(|| trimmed.strip_prefix('`'))
        .unwrap_or(trimmed);
    let lower = trimmed.to_lowercase();

    for commit_type in CONVENTIONAL_COMMIT_TYPES {
        let Some(rest) = lower.strip_prefix(commit_type) else {
            continue;
        };
        // `type: …` / `type：…`
        if rest.starts_with(':') || rest.starts_with('：') {
            return true;
        }
        // `type(scope): …`, `type(scope)!: …` — the colon after the closing
        // parenthesis is what proves this is a subject and not a path or prose.
        if rest.starts_with('(') {
            if let Some(close) = rest.find(')') {
                let after = rest[close + 1..].trim_start();
                let after = after.strip_prefix('!').unwrap_or(after);
                if after.starts_with(':') || after.starts_with('：') {
                    return true;
                }
            }
        }
    }
    false
}

/// Parse a raw AI response into a structured commit message.
///
/// Strips common boilerplate that small models produce, then takes the first
/// line that looks like a commit message as the summary.
fn parse_commit_message(text: &str) -> Result<GeneratedCommitMessage, String> {
    let cleaned = clean_response(text);
    let lines: Vec<&str> = cleaned.lines().collect();

    if lines.is_empty() {
        return Err("Empty response from AI".to_string());
    }

    // First non-empty line is the summary — strip surrounding quotes
    let summary = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .map(|s| {
            let s = s.trim();
            // Strip surrounding quotes (single or double)
            let s = s.strip_prefix('"').unwrap_or(s);
            let s = s.strip_suffix('"').unwrap_or(s);
            let s = s.strip_prefix('\'').unwrap_or(s);
            let s = s.strip_suffix('\'').unwrap_or(s);
            // Strip backtick wrapping
            let s = s.strip_prefix('`').unwrap_or(s);
            let s = s.strip_suffix('`').unwrap_or(s);
            s.trim().to_string()
        })
        .ok_or("No commit message generated")?;

    // Find the summary line index
    let summary_idx = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(0);

    // Rest becomes the body. Look for content after the summary:
    // 1. Prefer content after a blank line (standard git format)
    // 2. Fall back to the very next line if it exists (model skipped blank line)
    let body = if lines.len() > summary_idx + 1 {
        // Check if there's a blank line after summary
        let body_start =
            if summary_idx + 1 < lines.len() && lines[summary_idx + 1].trim().is_empty() {
                // Standard format: summary, blank line, body
                summary_idx + 2
            } else {
                // No blank line — body starts immediately after summary
                summary_idx + 1
            };

        if body_start < lines.len() {
            let body_text: String = lines[body_start..]
                .iter()
                .map(|s| s.trim())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();

            if !body_text.is_empty() {
                Some(body_text)
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(GeneratedCommitMessage { summary, body })
}

/// Strip boilerplate that small models commonly produce around commit messages.
fn clean_response(text: &str) -> String {
    let text = text.trim();

    // Remove markdown code fences
    let text = text
        .strip_prefix("```")
        .unwrap_or(text)
        .strip_suffix("```")
        .unwrap_or(text)
        .trim();

    // Skip preamble lines like "Here is...", "Sure...", "Commit message:", etc.
    //
    // The check is strict on purpose: a line that only STARTS with a type word
    // can be an echoed filename (`docs/localisation.md, …`), and dropping the
    // real subject into the body behind it is exactly the misplacement this
    // parser must not produce.
    let lines: Vec<&str> = text.lines().collect();
    let skip = lines
        .iter()
        .position(|l| is_conventional_commit_line(l))
        .unwrap_or(0);

    let result: String = lines[skip..].join("\n");

    // Strip trailing repetition / filler after double newline followed by non-body content
    // (e.g. "Let me know if..." or "---" separators)
    if let Some(pos) = result.find("\n---") {
        result[..pos].trim().to_string()
    } else {
        result.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockEngine {
        response: String,
        meta: Option<LoadedModelMeta>,
    }

    impl MockEngine {
        fn new(response: &str) -> Self {
            Self {
                response: response.to_string(),
                meta: None,
            }
        }

        fn with_meta(mut self, meta: LoadedModelMeta) -> Self {
            self.meta = Some(meta);
            self
        }
    }

    #[async_trait]
    impl InferenceEngine for MockEngine {
        async fn generate(&self, prompt: &str, _max_tokens: u32) -> Result<String, String> {
            if prompt.contains("purpose of this code change") {
                // Pass 1: per-file summary — vary by file to avoid dedup collapsing all
                if prompt.contains("f0") {
                    Ok("add new feature line".to_string())
                } else if prompt.contains("f1") {
                    Ok("update configuration settings".to_string())
                } else if prompt.contains("f2") {
                    Ok("fix error handling logic".to_string())
                } else if prompt.contains("f3") {
                    Ok("improve test coverage".to_string())
                } else if prompt.contains("f4") {
                    Ok("refactor module structure".to_string())
                } else if prompt.contains("f5") {
                    Ok("add logging statements".to_string())
                } else if prompt.contains("f6") {
                    Ok("update documentation comments".to_string())
                } else if prompt.contains("f7") {
                    Ok("remove deprecated code".to_string())
                } else {
                    Ok("add new feature line".to_string())
                }
            } else if prompt.contains("Group these file changes") {
                // Pass 2: condensing
                Ok(
                    "- Add new features\n- Update configuration\n- Improve test coverage"
                        .to_string(),
                )
            } else if prompt.contains("commit summary")
                || prompt.contains("git commit summary")
                || prompt.contains("conventional")
            {
                // Pass 3: summary line generation
                Ok(self.response.clone())
            } else {
                Ok(self.response.clone())
            }
        }
        fn model_name(&self) -> &str {
            "mock-model"
        }
        fn is_ready(&self) -> bool {
            true
        }
        fn model_meta(&self) -> Option<&LoadedModelMeta> {
            self.meta.as_ref()
        }
    }

    #[tokio::test]
    async fn test_provider_not_available_without_engine() {
        let provider = LocalInferenceProvider::new();
        assert!(!provider.is_available().await);
    }

    #[tokio::test]
    async fn test_provider_available_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert!(provider.is_available().await);
    }

    #[tokio::test]
    async fn test_generate_commit_message() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("feat: add new feature").with_meta(LoadedModelMeta {
            tier: ModelTier::UltraLight,
            architecture: "llama".to_string(),
            context_length: 8192,
        });
        provider.set_engine(Box::new(engine)).await;

        let diff = "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,1 +1,2 @@\n+new_line";
        let result = provider
            .generate_commit_message(diff, None, PromptLanguage::En)
            .await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        // UltraLight builds summary heuristically from bullets
        assert!(msg.summary.starts_with("feat"));
        assert!(msg.summary.contains("add new feature line"));
        // Single file diff — body is omitted (1 bullet adds nothing over summary)
        assert!(msg.body.is_none());
    }

    #[tokio::test]
    async fn test_generate_without_engine_fails() {
        let provider = LocalInferenceProvider::new();
        let result = provider
            .generate_commit_message("diff", None, PromptLanguage::En)
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_clear_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert!(provider.is_available().await);

        provider.clear_engine().await;
        assert!(!provider.is_available().await);
        assert_eq!(provider.get_status().await, LocalModelStatus::Unloaded);
    }

    #[tokio::test]
    async fn test_list_models_empty() {
        let provider = LocalInferenceProvider::new();
        let models = provider.list_models().await.unwrap();
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn test_list_models_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        let models = provider.list_models().await.unwrap();
        assert_eq!(models, vec!["mock-model"]);
    }

    #[tokio::test]
    async fn test_status_transitions() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.get_status().await, LocalModelStatus::Unloaded);

        provider.set_loading().await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Loading);

        provider.set_error().await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Error);

        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert_eq!(provider.get_status().await, LocalModelStatus::Ready);
    }

    #[tokio::test]
    async fn test_get_model_name() {
        let provider = LocalInferenceProvider::new();
        assert!(provider.get_model_name().await.is_none());

        let engine = MockEngine::new("test");
        provider.set_engine(Box::new(engine)).await;
        assert_eq!(
            provider.get_model_name().await,
            Some("mock-model".to_string())
        );
    }

    #[tokio::test]
    async fn test_provider_type() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.provider_type(), AiProviderType::LocalInference);
    }

    #[tokio::test]
    async fn test_provider_name() {
        let provider = LocalInferenceProvider::new();
        assert_eq!(provider.name(), "Local AI (Embedded)");
    }

    #[tokio::test]
    async fn test_generate_text_without_engine_fails() {
        let provider = LocalInferenceProvider::new();
        let result = provider.generate_text("system", "user", None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_generate_text_with_engine() {
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("generated text");
        provider.set_engine(Box::new(engine)).await;

        let result = provider
            .generate_text("system prompt", "user prompt", None, Some(100))
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "generated text");
    }

    #[test]
    fn test_parse_commit_message_summary_only() {
        let result = parse_commit_message("fix: resolve crash on startup").unwrap();
        assert_eq!(result.summary, "fix: resolve crash on startup");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_commit_message_with_body() {
        let result =
            parse_commit_message("feat: add new feature\n\nDetailed description here").unwrap();
        assert_eq!(result.summary, "feat: add new feature");
        assert_eq!(result.body, Some("Detailed description here".to_string()));
    }

    #[test]
    fn test_parse_commit_message_empty() {
        let result = parse_commit_message("");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_commit_message_whitespace_only() {
        let result = parse_commit_message("   \n  \n  ");
        assert!(result.is_err());
    }

    #[test]
    fn test_clean_response_strips_preamble() {
        let input = "Here is the commit message:\n\nfeat: add login page";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "feat: add login page");
    }

    #[test]
    fn test_clean_response_strips_code_fences() {
        let input = "```\nfix: resolve null pointer\n```";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "fix: resolve null pointer");
    }

    #[test]
    fn test_clean_response_strips_trailing_separator() {
        let input =
            "refactor: extract helper\n\nSimplify logic\n---\nLet me know if you need changes";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "refactor: extract helper");
        assert_eq!(result.body, Some("Simplify logic".to_string()));
    }

    #[test]
    fn test_clean_response_no_conventional_prefix() {
        // If model doesn't use conventional format, still take the first line
        let input = "Update the readme file";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "Update the readme file");
    }

    #[test]
    fn test_is_conventional_commit_line_rejects_paths_and_prose() {
        for line in [
            "docs/localisation.md, e2e/tests/localisation.spec.ts, src-tauri/src/lib.rs",
            "docs/localisation.md",
            "src/app-shell.ts, src/app-shell.test.ts",
            "testing the new flow manually",
            "feature list follows",
        ] {
            assert!(
                !is_conventional_commit_line(line),
                "{line:?} must not be read as a commit subject"
            );
        }
    }

    #[test]
    fn test_is_conventional_commit_line_accepts_real_subjects() {
        for line in [
            "feat: add localisation coverage",
            "fix(ui): keep the commit panel height",
            "feat(ai)!: change the prompt language wire format",
            "`chore: bump deps`",
            "\"docs: update the guide\"",
            "feat：添加本地化测试",
        ] {
            assert!(
                is_conventional_commit_line(line),
                "{line:?} should be read as a commit subject"
            );
        }
    }

    /// The exact misplacement seen in the app: the embedded model echoed the
    /// staged file list (which begins with `docs/`, so the old loose prefix
    /// check classified it as a `docs:` subject), then wrote the real subject.
    /// The file list became the 768-character summary and the subject the body.
    #[test]
    fn test_parser_prefers_subject_over_echoed_file_list() {
        let input = "docs/localisation.md, e2e/tests/localisation.spec.ts, \
             src-tauri/src/commands/menu.rs, src-tauri/src/lib.rs, src-tauri/src/menu.rs, \
             src/app-shell.ts, src/stores/settings.store.ts\n\
             feat: 添加本地化测试和 i18n 覆盖率断言";
        let result = parse_commit_message(input).unwrap();

        assert_eq!(result.summary, "feat: 添加本地化测试和 i18n 覆盖率断言");
        assert!(
            !result.summary.contains("docs/localisation.md"),
            "the echoed file list must never be the summary: {:?}",
            result.summary
        );
        assert!(
            result
                .body
                .as_deref()
                .is_none_or(|body| !body.contains("docs/localisation.md")),
            "the echoed file list must not be re-emitted as the body: {:?}",
            result.body
        );
    }

    /// Multi-line echoes and a blank line before the subject are the other two
    /// shapes the same failure takes.
    #[test]
    fn test_parser_skips_multi_line_file_list_preamble() {
        let input = "Files changed:\n\
             docs/localisation.md\n\
             e2e/tests/localisation.spec.ts\n\
             src-tauri/src/lib.rs\n\
             \n\
             feat(i18n): add Chinese locale coverage\n\
             \n\
             - add per-locale assertions";
        let result = parse_commit_message(input).unwrap();

        assert_eq!(result.summary, "feat(i18n): add Chinese locale coverage");
        assert_eq!(result.body, Some("- add per-locale assertions".to_string()));
    }

    #[test]
    fn test_parser_accepts_fullwidth_colon_subject() {
        let result = parse_commit_message("feat：添加本地化测试").unwrap();
        assert_eq!(result.summary, "feat：添加本地化测试");
    }

    #[test]
    fn test_parse_quoted_commit_with_preamble() {
        // Model wraps commit in quotes and adds preamble — both should be handled
        let input =
            "Here is the commit message:\n\n\"feat(auth): add token validation\"\n\nImprove authentication by checking token expiry.";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "feat(auth): add token validation");
        assert_eq!(
            result.body,
            Some("Improve authentication by checking token expiry.".to_string())
        );
    }

    #[test]
    fn test_parse_quoted_summary_no_body() {
        let input = "\"fix: resolve null pointer\"";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "fix: resolve null pointer");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_backtick_wrapped_summary() {
        let input = "`chore: update dependencies`";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "chore: update dependencies");
        assert!(result.body.is_none());
    }

    #[test]
    fn test_parse_body_without_blank_line() {
        // Model produces bullets immediately after summary (no blank line)
        let input = "refactor(tests): update test imports\n- Refactored e2e tests\n- Removed unused imports";
        let result = parse_commit_message(input).unwrap();
        assert_eq!(result.summary, "refactor(tests): update test imports");
        assert_eq!(
            result.body,
            Some("- Refactored e2e tests\n- Removed unused imports".to_string())
        );
    }

    #[test]
    fn test_clean_summary_line_basic() {
        assert_eq!(clean_summary_line("feat: add login"), "feat: add login");
    }

    #[test]
    fn test_clean_summary_line_strips_quotes() {
        assert_eq!(
            clean_summary_line("\"fix: resolve crash\""),
            "fix: resolve crash"
        );
        assert_eq!(
            clean_summary_line("`chore: update deps`"),
            "chore: update deps"
        );
    }

    #[test]
    fn test_clean_summary_line_strips_bullet() {
        assert_eq!(
            clean_summary_line("- feat: add feature"),
            "feat: add feature"
        );
    }

    #[test]
    fn test_clean_summary_line_empty_response() {
        assert_eq!(clean_summary_line(""), "chore: update code");
        assert_eq!(clean_summary_line("   \n  "), "chore: update code");
    }

    #[test]
    fn test_clean_summary_line_multiline_takes_first() {
        assert_eq!(
            clean_summary_line("feat: add login\n\nsome body text"),
            "feat: add login"
        );
    }

    #[tokio::test]
    async fn test_generate_commit_message_many_files() {
        // 6 files with Standard tier trigger the condensing pass (threshold=4)
        // while staying at the per-file pipeline's size limit (6).
        let provider = LocalInferenceProvider::new();
        let engine =
            MockEngine::new("feat(ai): update inference pipeline").with_meta(LoadedModelMeta {
                tier: ModelTier::Standard,
                architecture: "llama".to_string(),
                context_length: 8192,
            });
        provider.set_engine(Box::new(engine)).await;

        let mut diff = String::new();
        for i in 0..6 {
            diff.push_str(&format!(
                "diff --git a/src/f{i}.rs b/src/f{i}.rs\n--- a/src/f{i}.rs\n+++ b/src/f{i}.rs\n@@ -1,1 +1,2 @@\n+line{i}\n"
            ));
        }

        let result = provider
            .generate_commit_message(&diff, None, PromptLanguage::En)
            .await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        assert_eq!(msg.summary, "feat(ai): update inference pipeline");
        // Condensing pass returns 3 bullets
        assert!(msg.body.is_some());
        let body = msg.body.unwrap();
        assert!(body.contains("Add new features"));
        assert!(body.contains("Update configuration"));
        assert!(body.contains("Improve test coverage"));
    }

    #[tokio::test]
    async fn test_generate_commit_ultralight_many_files() {
        // UltraLight should NOT condense even with many files
        let provider = LocalInferenceProvider::new();
        let engine = MockEngine::new("chore: update multiple files").with_meta(LoadedModelMeta {
            tier: ModelTier::UltraLight,
            architecture: "gemma3".to_string(),
            context_length: 8192,
        });
        provider.set_engine(Box::new(engine)).await;

        // 6 files: above the UltraLight tier's (disabled) condensing threshold
        // but at the per-file pipeline's size limit.
        let mut diff = String::new();
        for i in 0..6 {
            diff.push_str(&format!(
                "diff --git a/src/f{i}.rs b/src/f{i}.rs\n--- a/src/f{i}.rs\n+++ b/src/f{i}.rs\n@@ -1,1 +1,2 @@\n+line{i}\n"
            ));
        }

        let result = provider
            .generate_commit_message(&diff, None, PromptLanguage::En)
            .await;
        assert!(result.is_ok());
        let msg = result.unwrap();
        // UltraLight builds summary heuristically
        assert!(
            msg.summary.contains(':'),
            "Expected conventional commit format, got: {}",
            msg.summary
        );
        // UltraLight: no condensing pass, all unique bullets pass through
        assert!(msg.body.is_some());
        let body = msg.body.unwrap();
        // Verify original per-file bullets are present (not condensed)
        assert!(body.contains("Add new feature line"));
        assert!(body.contains("Update configuration settings"));
        assert!(body.contains("Refactor module structure"));
    }

    #[test]
    fn test_extract_file_diffs_single_file() {
        let diff = "\
diff --git a/src/auth.rs b/src/auth.rs
--- a/src/auth.rs
+++ b/src/auth.rs
@@ -1,3 +1,5 @@
-    token.len() > 0
+    if token.is_empty() {
+        return false;
+    }
+    claims.exp > Utc::now().timestamp()";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/auth.rs");
        assert!(files[0].content.contains("token.len() > 0"));
        assert!(files[0].content.contains("token.is_empty()"));
    }

    #[test]
    fn test_extract_file_diffs_multiple_files() {
        let diff = "\
diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,1 +1,1 @@
-old_line
+new_line
diff --git a/src/b.rs b/src/b.rs
--- a/src/b.rs
+++ b/src/b.rs
@@ -1,1 +1,1 @@
-another_old
+another_new";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[1].path, "src/b.rs");
        assert!(files[0].content.contains("old_line"));
        assert!(files[1].content.contains("another_new"));
    }

    #[test]
    fn test_extract_file_diffs_empty() {
        let files = extract_file_diffs("");
        assert!(files.is_empty());
    }

    /// The per-file budget is a BYTE count, so a multi-byte character sitting
    /// across it panicked — killing the local-model commit summary for any diff
    /// with an accent, a CJK identifier or an emoji in it, which is routine.
    #[test]
    fn test_extract_file_diffs_truncates_multibyte_content_without_panicking() {
        // 'é' is two bytes, so the 2500-byte cut lands mid-character for one of
        // these lengths whatever the header adds.
        for pad in 0..4 {
            let body = format!("{}{}", "a".repeat(pad), "é".repeat(4000));
            let diff = format!(
                "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+{}",
                body
            );

            let files = extract_file_diffs(&diff);
            assert_eq!(files.len(), 1);
            assert!(
                files[0].content.ends_with("\n[truncated]"),
                "oversized content must be truncated"
            );
            assert!(
                files[0].content.len() <= 2500 + "\n[truncated]".len(),
                "truncation must respect the budget"
            );
        }
    }

    #[test]
    fn test_extract_file_diffs_binary_file() {
        let diff = "\
diff --git a/project.xcuserstate b/project.xcuserstate
Binary files a/project.xcuserstate and b/project.xcuserstate differ";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "project.xcuserstate");
        assert_eq!(files[0].content, "[binary file modified]");
    }

    #[test]
    fn test_extract_file_diffs_mixed_text_and_binary() {
        let diff = "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,1 +1,1 @@
-old_code
+new_code
diff --git a/assets/icon.png b/assets/icon.png
Binary files a/assets/icon.png and b/assets/icon.png differ";

        let files = extract_file_diffs(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/main.rs");
        assert!(files[0].content.contains("new_code"));
        assert_eq!(files[1].path, "assets/icon.png");
        assert_eq!(files[1].content, "[binary file modified]");
    }

    #[test]
    fn test_format_prompt_llama() {
        let result = format_prompt("llama", "sys", "usr");
        assert!(result.contains("<|start_header_id|>system<|end_header_id|>"));
        assert!(result.contains("sys"));
        assert!(result.contains("usr"));
        assert!(result.contains("<|eot_id|>"));
        assert!(result.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"));
    }

    #[test]
    fn test_format_prompt_gemma3() {
        let result = format_prompt("gemma3", "sys", "usr");
        assert!(result.contains("<start_of_turn>user"));
        assert!(result.contains("sys\n\nusr"));
        assert!(result.contains("<end_of_turn>"));
        assert!(result.ends_with("<start_of_turn>model\n"));
    }

    #[test]
    fn test_format_prompt_phi() {
        let result = format_prompt("phi", "sys", "usr");
        assert!(result.contains("<|system|>"));
        assert!(result.contains("<|user|>"));
        assert!(result.contains("<|assistant|>"));
        assert!(result.contains("<|end|>"));
    }

    #[test]
    fn test_format_prompt_qwen() {
        for arch in ["qwen", "qwen2", "qwen3"] {
            let result = format_prompt(arch, "sys", "usr");
            assert!(result.contains("<|im_start|>system\nsys<|im_end|>"));
            assert!(result.contains("<|im_start|>user\nusr<|im_end|>"));
            assert!(result.ends_with("<|im_start|>assistant\n"));
        }
    }

    #[test]
    fn test_format_prompt_mistral() {
        let result = format_prompt("mistral", "sys", "usr");
        assert_eq!(result, "[INST] sys\n\nusr [/INST]");
    }

    #[test]
    fn test_format_prompt_fallback() {
        let result = format_prompt("unknown-arch", "sys", "usr");
        assert_eq!(result, "sys\n\nusr");
    }

    #[test]
    fn test_pipeline_config_ultralight() {
        let config = PipelineConfig::for_tier(ModelTier::UltraLight);
        assert_eq!(config.per_file_tokens, 25);
        assert_eq!(config.summary_tokens, 30);
        assert_eq!(config.max_body_bullets, 0); // unlimited
        assert!(!config.enable_condensing);
    }

    #[test]
    fn test_pipeline_config_standard() {
        let config = PipelineConfig::for_tier(ModelTier::Standard);
        assert_eq!(config.per_file_tokens, 30);
        assert_eq!(config.summary_tokens, 40);
        assert_eq!(config.max_body_bullets, 10);
        assert!(config.enable_condensing);
        assert_eq!(config.condensing_tokens, 150);
        assert_eq!(config.condensing_threshold, 4);
    }

    #[test]
    fn test_pipeline_config_pro() {
        let config = PipelineConfig::for_tier(ModelTier::Pro);
        assert_eq!(config.per_file_tokens, 40);
        assert_eq!(config.summary_tokens, 50);
        assert_eq!(config.max_body_bullets, 12);
        assert!(config.enable_condensing);
        assert_eq!(config.condensing_tokens, 200);
        assert_eq!(config.condensing_threshold, 4);
    }

    #[test]
    fn test_build_summary_adds() {
        let bullets = vec![
            "- Add new login page".to_string(),
            "- Add auth middleware".to_string(),
            "- Add user model".to_string(),
        ];
        let paths = vec![
            "src/auth/login.rs",
            "src/auth/middleware.rs",
            "src/auth/model.rs",
        ];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(summary.starts_with("feat(auth):"), "got: {summary}");
    }

    #[test]
    fn test_build_summary_fixes() {
        let bullets = vec![
            "- Fix crash on empty input".to_string(),
            "- Resolve null pointer in parser".to_string(),
        ];
        let paths = vec!["src/parser/main.rs", "src/parser/util.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(summary.starts_with("fix(parser):"), "got: {summary}");
    }

    #[test]
    fn test_build_summary_no_scope() {
        let bullets = vec![
            "- Add feature A".to_string(),
            "- Update feature B".to_string(),
            "- Fix feature C".to_string(),
        ];
        let paths = vec!["src/alpha/foo.rs", "src/beta/bar.rs", "src/gamma/baz.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        // No dominant directory — no scope
        assert!(!summary.contains('('), "got: {summary}");
    }

    #[test]
    fn test_build_summary_truncates_long() {
        let bullets = vec![
            "- Add a very long description that goes on and on about what was changed in this file"
                .to_string(),
        ];
        let paths = vec!["src/main.rs"];
        let summary = build_summary_from_bullets(&bullets, &paths);
        assert!(
            summary.len() <= 72,
            "got {} chars: {summary}",
            summary.len()
        );
    }

    #[test]
    fn test_derive_scope_dominant() {
        let paths = vec!["src/ai/foo.rs", "src/ai/bar.rs", "src/ai/baz.rs"];
        assert_eq!(derive_scope(&paths), "ai");
    }

    #[test]
    fn test_derive_scope_no_dominant() {
        let paths = vec!["src/a/foo.rs", "src/b/bar.rs", "src/c/baz.rs"];
        assert_eq!(derive_scope(&paths), "");
    }

    #[test]
    fn test_clean_bullet_rejects_single_word() {
        assert_eq!(clean_bullet_text("Update"), "");
        assert_eq!(clean_bullet_text("Add"), "");
    }

    #[test]
    fn test_clean_bullet_rejects_diff_artifacts() {
        assert_eq!(clean_bullet_text("@@ -668,7 +668,51 @@ struct Foo"), "");
    }

    // ------------------------------------------------------------------
    // Prompt language, noise filtering and the single-pass path
    // ------------------------------------------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// An engine that records how often it is asked to generate, and the
    /// prompts it saw — the observable contract of the pipeline rewrite.
    struct CountingEngine {
        calls: Arc<AtomicUsize>,
        prompts: Arc<Mutex<Vec<String>>>,
        meta: Option<LoadedModelMeta>,
    }

    impl CountingEngine {
        fn new(meta: LoadedModelMeta) -> (Self, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let prompts = Arc::new(Mutex::new(Vec::new()));
            (
                Self {
                    calls: calls.clone(),
                    prompts: prompts.clone(),
                    meta: Some(meta),
                },
                calls,
                prompts,
            )
        }
    }

    #[async_trait]
    impl InferenceEngine for CountingEngine {
        async fn generate(&self, prompt: &str, _max_tokens: u32) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.prompts.lock().unwrap().push(prompt.to_string());
            if prompt.contains("purpose of this code change") {
                Ok("add a per-file change".to_string())
            } else if prompt.contains("Group these file changes") {
                Ok("- Add one thing\n- Add another thing\n- Update a third thing".to_string())
            } else if prompt.contains("Write ONE git commit message") {
                Ok(
                    "feat(ai): rework the multi-file pipeline\n\n- Added the single-pass path"
                        .to_string(),
                )
            } else {
                Ok("feat(ai): rework the multi-file pipeline".to_string())
            }
        }

        fn model_name(&self) -> &str {
            "counting-mock"
        }

        fn is_ready(&self) -> bool {
            true
        }

        fn model_meta(&self) -> Option<&LoadedModelMeta> {
            self.meta.as_ref()
        }
    }

    struct FailingEngine;

    #[async_trait]
    impl InferenceEngine for FailingEngine {
        async fn generate(&self, _prompt: &str, _max_tokens: u32) -> Result<String, String> {
            Err("warm-up failure".to_string())
        }

        fn model_name(&self) -> &str {
            "failing-mock"
        }

        fn is_ready(&self) -> bool {
            true
        }
    }

    fn standard_meta() -> LoadedModelMeta {
        LoadedModelMeta {
            tier: ModelTier::Standard,
            architecture: "llama".to_string(),
            context_length: 8192,
        }
    }

    fn diff_for_files(paths: &[&str]) -> String {
        let mut diff = String::new();
        for path in paths {
            diff.push_str(&format!(
                "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,2 @@\n+line\n"
            ));
        }
        diff
    }

    #[test]
    fn test_is_noise_file_filters_lockfiles_generated_output_and_binaries() {
        for path in [
            "package-lock.json",
            "web/yarn.lock",
            "pnpm-lock.yaml",
            "Cargo.lock",
            "poetry.lock",
            "composer.lock",
            "go.sum",
            "dist/app.js",
            "build/main.o",
            "node_modules/left-pad/index.js",
            "vendor/lib.go",
            "target/debug/gitnado",
            "assets/app.min.js",
            "assets/app.min.css",
            "assets/app.js.map",
            "assets/logo.png",
            "docs/manual.pdf",
            "installer.dmg",
            "font.woff2",
        ] {
            assert!(is_noise_file(path), "{path} should be noise");
        }
    }

    #[test]
    fn test_is_noise_file_keeps_reviewable_source_files() {
        for path in [
            "src/main.rs",
            "src-tauri/src/services/ai/mod.rs",
            "web/src/components/gn-commit-panel.ts",
            "docs/localisation.md",
            "scripts/build-release.sh",
            "README.md",
            "package.json",
        ] {
            assert!(!is_noise_file(path), "{path} must not be filtered");
        }
    }

    #[test]
    fn test_filter_noise_files_falls_back_when_everything_is_noise() {
        let files = vec![
            FileDiff {
                path: "package-lock.json".to_string(),
                content: "+{}".to_string(),
            },
            FileDiff {
                path: "assets/logo.png".to_string(),
                content: "[binary file modified]".to_string(),
            },
        ];
        // Nothing relevant survives, so the unfiltered set is summarized
        // rather than returning "no changes".
        assert_eq!(filter_noise_files(files).len(), 2);
    }

    #[test]
    fn test_filter_noise_files_keeps_the_relevant_subset() {
        let files = vec![
            FileDiff {
                path: "package-lock.json".to_string(),
                content: "+{}".to_string(),
            },
            FileDiff {
                path: "src/main.rs".to_string(),
                content: "+fn main() {}".to_string(),
            },
        ];
        let kept = filter_noise_files(files);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].path, "src/main.rs");
    }

    #[tokio::test]
    async fn test_many_files_use_a_single_generate_call() {
        let provider = LocalInferenceProvider::new();
        let (engine, calls, _prompts) = CountingEngine::new(standard_meta());
        provider.set_engine(Box::new(engine)).await;

        let paths: Vec<String> = (0..10).map(|i| format!("src/module{i}.rs")).collect();
        let path_refs: Vec<&str> = paths.iter().map(|p| p.as_str()).collect();
        let diff = diff_for_files(&path_refs);

        let message = provider
            .generate_commit_message(&diff, None, PromptLanguage::En)
            .await
            .expect("single-pass generation succeeds");

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a 10-file stage must cost exactly one generation, not one per file"
        );
        assert!(!message.summary.trim().is_empty());
    }

    #[tokio::test]
    async fn test_small_change_set_still_uses_the_per_file_pipeline() {
        let provider = LocalInferenceProvider::new();
        let (engine, calls, _prompts) = CountingEngine::new(standard_meta());
        provider.set_engine(Box::new(engine)).await;

        let diff = diff_for_files(&["src/a.rs", "src/b.rs", "src/c.rs"]);
        provider
            .generate_commit_message(&diff, None, PromptLanguage::En)
            .await
            .expect("per-file generation succeeds");

        // 3 per-file generations + 1 summary-line generation.
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn test_noise_files_never_appear_in_the_prompt() {
        let provider = LocalInferenceProvider::new();
        let (engine, calls, prompts) = CountingEngine::new(standard_meta());
        provider.set_engine(Box::new(engine)).await;

        let mut paths: Vec<String> = (0..7).map(|i| format!("src/module{i}.rs")).collect();
        paths.push("package-lock.json".to_string());
        paths.push("Cargo.lock".to_string());
        paths.push("dist/app.min.js".to_string());
        paths.push("node_modules/left-pad/index.js".to_string());
        paths.push("assets/logo.png".to_string());
        let path_refs: Vec<&str> = paths.iter().map(|p| p.as_str()).collect();
        let diff = diff_for_files(&path_refs);

        provider
            .generate_commit_message(&diff, None, PromptLanguage::En)
            .await
            .expect("generation succeeds");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let prompts = prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1);
        let prompt = &prompts[0];
        for noise in [
            "package-lock.json",
            "Cargo.lock",
            "dist/app.min.js",
            "node_modules",
            "assets/logo.png",
        ] {
            assert!(
                !prompt.contains(noise),
                "noise file {noise} reached the model prompt"
            );
        }
        assert!(prompt.contains("src/module0.rs"));
    }

    #[test]
    fn test_build_single_pass_diff_is_bounded_and_reports_omitted_files() {
        let files: Vec<FileDiff> = (0..40)
            .map(|i| FileDiff {
                path: format!("src/module{i}.rs"),
                content: "+".to_string() + &"x".repeat(500),
            })
            .collect();

        let condensed = build_single_pass_diff(&files, PromptLanguage::En);
        assert!(
            condensed.len() <= SINGLE_PASS_DIFF_BUDGET_BYTES + 64,
            "condensed diff must respect the budget, got {} bytes",
            condensed.len()
        );
        assert!(condensed.contains("more files not shown"));
        assert!(condensed.contains("### src/module0.rs"));
        // Only a small representative slice of paths is shown, so the model has
        // less file-list text to echo; the rest is a count.
        assert!(
            condensed.matches("### ").count() <= SINGLE_PASS_MAX_FILES,
            "showed more headers than the cap"
        );
        assert!(condensed.contains("40 files changed"));

        let zh = build_single_pass_diff(&files, PromptLanguage::Zh);
        assert!(zh.contains("个文件未展示"));
    }

    #[test]
    fn test_build_single_pass_diff_omits_files_beyond_the_show_cap() {
        let files: Vec<FileDiff> = (0..134)
            .map(|i| FileDiff {
                path: format!("src/file{i}.ts"),
                content: format!("+line{i}\n"),
            })
            .collect();

        let condensed = build_single_pass_diff(&files, PromptLanguage::En);

        assert_eq!(condensed.matches("### ").count(), SINGLE_PASS_MAX_FILES);
        assert!(condensed.contains("134 files changed"));
        assert!(
            condensed.contains("124 more files not shown"),
            "every file beyond the cap must be reported: {condensed:?}"
        );
    }

    #[test]
    fn test_build_single_pass_diff_keeps_chinese_content_on_char_boundaries() {
        let files: Vec<FileDiff> = (0..2)
            .map(|i| FileDiff {
                path: format!("src/中文{i}.rs"),
                content: "改动内容".repeat(400),
            })
            .collect();

        // A byte cut inside a three-byte character would panic here.
        let condensed = build_single_pass_diff(&files, PromptLanguage::Zh);
        assert!(condensed.contains("src/中文0.rs"));
        assert!(condensed.len() <= SINGLE_PASS_DIFF_BUDGET_BYTES + 64);
    }

    #[test]
    fn test_summary_needs_repair_detects_file_list_echoes() {
        // The shape the embedded model returned in the app: a long path list
        // with the message glued onto the last path.
        let echo = "docs/localisation.md, e2e/tests/localisation.spec.ts, \
             src-tauri/src/commands/menu.rs, src-tauri/src/lib.rs, src/app-shell.ts, \
             src/stores/settings.store.ts: 添加本地化测试和 i18n 覆盖率断言";
        assert!(summary_needs_repair(echo));

        // A real subject is short and is never flagged.
        assert!(!summary_needs_repair(
            "feat(i18n): add Chinese locale coverage"
        ));
        assert!(!summary_needs_repair("chore: update 134 files"));
        // A short answer that is just a changed path is not a message either.
        assert!(summary_needs_repair("docs/localisation.md"));
        assert!(summary_needs_repair(
            "src/components/sidebar/gn-commit-panel.ts"
        ));
        // Long prose (no path density) is still a message, not an echo.
        let prose = "这是一段很长的提交摘要，用来说明本次改动的背景、动机和影响范围，\
             内容明显超过一百个字符，但是不包含任何文件名或路径，也没有用逗号罗列多个项目；\
             之所以写这么长，是为了验证解析器不会把一段正常的长摘要误判成文件列表回显";
        assert!(prose.chars().count() > 100);
        assert!(!summary_needs_repair(prose));
    }

    /// An engine that answers the single-pass prompt with an echoed file list,
    /// and (optionally) answers the repair prompt properly.
    struct FileListEchoEngine {
        repair_answer: Option<&'static str>,
        calls: Arc<AtomicUsize>,
        meta: Option<LoadedModelMeta>,
    }

    #[async_trait]
    impl InferenceEngine for FileListEchoEngine {
        async fn generate(&self, prompt: &str, _max_tokens: u32) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let is_repair_prompt = prompt.contains("Rewrite the following draft")
                || prompt.contains("把下面这段草稿改写");
            if is_repair_prompt {
                if let Some(answer) = self.repair_answer {
                    return Ok(answer.to_string());
                }
            }
            Ok("docs/localisation.md, e2e/tests/localisation.spec.ts, \
                src-tauri/src/commands/menu.rs, src-tauri/src/lib.rs, src/app-shell.ts, \
                src/stores/settings.store.ts: 添加本地化测试和覆盖率断言"
                .to_string())
        }

        fn model_name(&self) -> &str {
            "file-list-echo"
        }

        fn is_ready(&self) -> bool {
            true
        }

        fn model_meta(&self) -> Option<&LoadedModelMeta> {
            self.meta.as_ref()
        }
    }

    fn many_file_diff(count: usize) -> String {
        let paths: Vec<String> = (0..count).map(|i| format!("src/module{i}.rs")).collect();
        let path_refs: Vec<&str> = paths.iter().map(|path| path.as_str()).collect();
        diff_for_files(&path_refs)
    }

    /// The embedded model echoed the staged file list instead of writing a
    /// subject. One focused repair call must turn that into a real message
    /// rather than letting the blob reach the summary box.
    #[tokio::test]
    async fn test_single_pass_repairs_a_file_list_echo() {
        let provider = LocalInferenceProvider::new();
        let calls = Arc::new(AtomicUsize::new(0));
        provider
            .set_engine(Box::new(FileListEchoEngine {
                repair_answer: Some("feat(i18n): 添加本地化测试与覆盖率断言"),
                calls: calls.clone(),
                meta: Some(standard_meta()),
            }))
            .await;

        let message = provider
            .generate_commit_message(&many_file_diff(10), None, PromptLanguage::Zh)
            .await
            .expect("generation succeeds");

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "expected one generation plus one repair"
        );
        assert_eq!(message.summary, "feat(i18n): 添加本地化测试与覆盖率断言");
        assert!(
            !message.summary.contains('/'),
            "no path may survive in the summary: {:?}",
            message.summary
        );
    }

    /// When even the repair call echoes paths, the deterministic fallback keeps
    /// an unusable blob out of the summary box.
    #[tokio::test]
    async fn test_single_pass_falls_back_when_repair_also_echoes() {
        let provider = LocalInferenceProvider::new();
        let calls = Arc::new(AtomicUsize::new(0));
        provider
            .set_engine(Box::new(FileListEchoEngine {
                repair_answer: None,
                calls: calls.clone(),
                meta: Some(standard_meta()),
            }))
            .await;

        let message = provider
            .generate_commit_message(&many_file_diff(10), None, PromptLanguage::En)
            .await
            .expect("generation succeeds");

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(message.summary, "chore: update 10 files");
        assert!(message.body.is_none());
    }

    #[test]
    fn test_single_pass_prompt_is_language_aware() {
        for (en, zh) in [
            (PERFILE_SYSTEM, PERFILE_SYSTEM_ZH),
            (CONDENSE_SYSTEM, CONDENSE_SYSTEM_ZH),
            (SUMMARY_SYSTEM_STANDARD, SUMMARY_SYSTEM_STANDARD_ZH),
            (SINGLE_PASS_SYSTEM, SINGLE_PASS_SYSTEM_ZH),
        ] {
            assert_ne!(en, zh);
            assert!(
                zh.contains("简体中文"),
                "zh prompt must require Chinese output"
            );
        }
        assert_eq!(perfile_system(PromptLanguage::En), PERFILE_SYSTEM);
        assert_eq!(perfile_system(PromptLanguage::Zh), PERFILE_SYSTEM_ZH);
        assert_eq!(condense_system(PromptLanguage::Zh), CONDENSE_SYSTEM_ZH);
        assert_eq!(
            summary_system(PromptLanguage::Zh),
            SUMMARY_SYSTEM_STANDARD_ZH
        );
        assert_eq!(
            single_pass_system(PromptLanguage::Zh),
            SINGLE_PASS_SYSTEM_ZH
        );
    }

    /// The heuristic summary path is used by the 1B model, whose bullets can be
    /// Chinese now — and the old `&summary[..69]` byte slice panicked on CJK.
    #[test]
    fn test_build_summary_recognises_chinese_action_verbs() {
        let add =
            build_summary_from_bullets(&["- 添加登录页面".to_string()], &["src/auth/main.rs"]);
        assert!(add.starts_with("feat"), "got: {add}");

        let fix =
            build_summary_from_bullets(&["- 修复空输入崩溃".to_string()], &["src/parser/main.rs"]);
        assert!(fix.starts_with("fix"), "got: {fix}");

        let remove = build_summary_from_bullets(&["- 删除废弃代码".to_string()], &[]);
        assert!(remove.starts_with("refactor"), "got: {remove}");

        let update = build_summary_from_bullets(&["- 更新配置项".to_string()], &[]);
        assert!(update.starts_with("chore"), "got: {update}");
    }

    #[test]
    fn test_build_summary_truncates_chinese_without_panicking() {
        let bullets = vec![format!("- 添加{}", "非常长的中文描述".repeat(20))];
        let summary = build_summary_from_bullets(&bullets, &["src/中文模块/main.rs"]);
        assert!(!summary.is_empty());
        assert!(
            summary.chars().count() <= 72,
            "summary must be truncated by chars, got {} chars",
            summary.chars().count()
        );
    }

    #[tokio::test]
    async fn test_warm_up_runs_one_tiny_generation() {
        let provider = LocalInferenceProvider::new();
        let (engine, calls, prompts) = CountingEngine::new(standard_meta());
        provider.set_engine(Box::new(engine)).await;

        provider.warm_up().await.expect("warm-up succeeds");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(prompts.lock().unwrap()[0].contains("Reply with OK."));
    }

    #[tokio::test]
    async fn test_warm_up_without_an_engine_is_a_no_op() {
        let provider = LocalInferenceProvider::new();
        assert!(provider.warm_up().await.is_ok());
    }

    /// Warm-up is best-effort: a failure must leave the model usable.
    #[tokio::test]
    async fn test_warm_up_failure_does_not_poison_the_provider() {
        let provider = LocalInferenceProvider::new();
        provider.set_engine(Box::new(FailingEngine)).await;

        assert!(provider.warm_up().await.is_err());
        assert!(
            provider.is_available().await,
            "a failed warm-up must not unload or error the model"
        );
    }
}
