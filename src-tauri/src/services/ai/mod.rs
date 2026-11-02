//! AI Provider System for commit message generation
//!
//! This module provides a flexible, provider-based AI system that supports
//! multiple backends including local (Ollama, LM Studio) and cloud
//! (OpenAI, Anthropic) providers.

pub mod config;
pub mod local;
pub mod mcp;
pub mod providers;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

pub use config::{AiConfig, ProviderSettings};
pub use providers::{
    AnthropicProvider, GeminiProvider, GithubCopilotProvider, LoadedModelMeta,
    LocalInferenceProvider, OllamaProvider, OpenAiCompatibleProvider,
};

use crate::commands::local_ai::SharedLocalAiState;

/// AI provider types supported by the system
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderType {
    Ollama,
    LmStudio,
    OpenAi,
    Anthropic,
    GithubCopilot,
    GoogleGemini,
    LocalInference,
}

impl AiProviderType {
    pub fn display_name(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "Ollama",
            AiProviderType::LmStudio => "LM Studio",
            AiProviderType::OpenAi => "OpenAI",
            AiProviderType::Anthropic => "Anthropic Claude",
            AiProviderType::GithubCopilot => "GitHub Models",
            AiProviderType::GoogleGemini => "Google Gemini",
            AiProviderType::LocalInference => "Local AI (Embedded)",
        }
    }

    pub fn default_endpoint(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "http://localhost:11434",
            AiProviderType::LmStudio => "http://localhost:1234/v1",
            AiProviderType::OpenAi => "https://api.openai.com/v1",
            AiProviderType::Anthropic => "https://api.anthropic.com",
            AiProviderType::GithubCopilot => "https://models.inference.ai.azure.com",
            AiProviderType::GoogleGemini => "https://generativelanguage.googleapis.com",
            AiProviderType::LocalInference => "",
        }
    }

    pub fn requires_api_key(&self) -> bool {
        match self {
            AiProviderType::Ollama | AiProviderType::LmStudio | AiProviderType::LocalInference => {
                false
            }
            AiProviderType::OpenAi
            | AiProviderType::Anthropic
            | AiProviderType::GithubCopilot
            | AiProviderType::GoogleGemini => true,
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            AiProviderType::Ollama => "llama3.2",
            AiProviderType::LmStudio => "local-model",
            AiProviderType::OpenAi => "gpt-4o-mini",
            AiProviderType::Anthropic => "claude-haiku-4-5",
            AiProviderType::GithubCopilot => "gpt-4o",
            AiProviderType::GoogleGemini => "gemini-2.0-flash",
            AiProviderType::LocalInference => "local",
        }
    }

    pub fn all() -> Vec<AiProviderType> {
        vec![
            AiProviderType::Ollama,
            AiProviderType::LmStudio,
            AiProviderType::OpenAi,
            AiProviderType::Anthropic,
            AiProviderType::GithubCopilot,
            AiProviderType::GoogleGemini,
            AiProviderType::LocalInference,
        ]
    }
}

/// Language AI prompts are written in — and therefore the language every
/// human-visible value the model returns is written in.
///
/// Deliberately separate from the UI language: a user reading a Chinese
/// interface may still want English commit messages (or vice versa), so this
/// travels with each request instead of being derived from the interface.
///
/// `Default` is `En` so a frontend that predates the setting — or an older
/// persisted payload — keeps exactly today's English prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptLanguage {
    #[default]
    En,
    Zh,
}

impl PromptLanguage {
    /// True when the request must produce Simplified Chinese text.
    pub fn is_zh(self) -> bool {
        matches!(self, PromptLanguage::Zh)
    }
}

/// Generated commit message result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCommitMessage {
    pub summary: String,
    pub body: Option<String>,
}

/// AI-generated conflict resolution suggestion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionSuggestion {
    pub resolved_content: String,
    pub explanation: String,
}

/// Information about an AI provider
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderInfo {
    pub provider_type: AiProviderType,
    pub name: String,
    pub available: bool,
    /// Whether `available` is an answer or a guess.
    ///
    /// Listing the providers must not itself be a network request: for an
    /// OpenAI-compatible cloud provider the reachability probe is an outbound
    /// models-list call, and Settings has to be able to enumerate providers in
    /// order to turn the cloud one OFF. So with offline mode on (or the host
    /// outside the allowlist) the probe is skipped and this is `false`,
    /// meaning "not probed" rather than "unavailable".
    pub probed: bool,
    pub requires_api_key: bool,
    pub has_api_key: bool,
    pub endpoint: String,
    pub models: Vec<String>,
    pub selected_model: Option<String>,
}

/// Why AI is unavailable, for the surfaces that have to explain it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUnavailable {
    /// Human-readable reason, naming the provider when one is at fault.
    pub reason: String,
    /// True when a provider is chosen in Settings but unreachable, rather than
    /// no provider being configured at all. A surface that hides its AI
    /// affordances when AI was never set up still shows them, disabled, here —
    /// they worked before and the user needs to know why they stopped.
    pub provider_selected: bool,
}

/// Trait for AI providers
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Get the provider type
    fn provider_type(&self) -> AiProviderType;

    /// Get the display name
    fn name(&self) -> &str;

    /// Check if the provider is available (e.g., service is running)
    async fn is_available(&self) -> bool;

    /// List available models from the provider
    async fn list_models(&self) -> Result<Vec<String>, String>;

    /// Generate a commit message from a diff, with every human-visible value
    /// (summary and body) written in `language`.
    async fn generate_commit_message(
        &self,
        diff: &str,
        model: Option<&str>,
        language: PromptLanguage,
    ) -> Result<GeneratedCommitMessage, String>;

    /// Generate free-form text from a system prompt and user prompt
    async fn generate_text(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        model: Option<&str>,
        max_tokens: Option<u32>,
    ) -> Result<String, String>;
}

/// The commit message generation prompt
pub const COMMIT_MESSAGE_PROMPT: &str = r#"Generate a concise git commit message for the following diff.
Use conventional commit format: type(scope): description
Types: feat, fix, docs, style, refactor, test, chore

Rules:
- The FIRST line is the commit subject; put any explanation after a blank line
- Summary line should be 50 characters or less
- Use imperative mood ("add" not "added")
- Do not end summary with a period
- If the change is simple, just provide the summary
- Only add a body if the change needs explanation
- Never list the changed file names or paths in the message, and never repeat the diff
- Output ONLY the commit message — no preamble, no explanation, no code fences

Diff:
"#;

/// Chinese (Simplified) variant of [`COMMIT_MESSAGE_PROMPT`].
pub const COMMIT_MESSAGE_PROMPT_ZH: &str = r#"为以下代码差异（diff）生成一条简洁的 git 提交信息。
使用约定式提交格式：type(scope): 描述
类型：feat, fix, docs, style, refactor, test, chore

规则：
- 第一行是提交摘要；需要解释时在空行之后写正文
- 摘要行不超过 50 个字符
- 使用祈使语气（"添加"而不是"已添加"）
- 摘要结尾不要加句号
- 如果改动很简单，只提供摘要
- 只有在改动需要解释时才添加正文
- 不要在提交信息中列出文件名或路径，也不要重复 diff 内容
- 只输出提交信息本身，不要任何前言、解释或代码块
- 摘要和正文等所有人类可读内容必须使用简体中文

Diff:
"#;

/// The commit-message prompt for `language`.
pub fn commit_message_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        COMMIT_MESSAGE_PROMPT_ZH
    } else {
        COMMIT_MESSAGE_PROMPT
    }
}

/// Maximum diff size, in BYTES, to send to the AI provider.
pub const MAX_DIFF_BYTES: usize = 12000;

/// Maximum conflict context size, in BYTES, to send to the AI provider.
pub const MAX_CONFLICT_CONTEXT_BYTES: usize = 16000;

/// Maximum commit text size, in BYTES, to send for changelog generation.
pub const MAX_CHANGELOG_BYTES: usize = 24000;

/// Generated changelog result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedChangelog {
    pub content: String,
}

/// System prompt for AI-powered changelog generation
pub const CHANGELOG_PROMPT: &str = r#"Analyze the following git commits and generate structured release notes in Markdown.

Group changes into these sections (omit empty sections):
## Features
## Bug Fixes
## Performance
## Documentation
## Internal

Rules:
- Write from a user's perspective (what changed for them)
- Use past tense ("Added", "Fixed", "Improved")
- One bullet per logical change (merge related commits into a single bullet)
- Skip merge commits and trivial dependency bumps unless significant
- Include commit short hash in parentheses at end of each bullet, e.g. (abc1234)
- Keep each bullet to one concise sentence
- Do NOT include a title or version header — just the sections

Commits:
"#;

/// Chinese (Simplified) variant of [`CHANGELOG_PROMPT`].
pub const CHANGELOG_PROMPT_ZH: &str = r#"分析以下 git 提交记录，并生成 Markdown 格式的结构化发布说明。

将改动归类到以下章节（省略空章节）：
## 新功能
## 缺陷修复
## 性能
## 文档
## 内部改动

规则：
- 从用户视角描述（说明对他们有什么变化）
- 使用过去时（"新增"、"修复"、"改进"）
- 每个逻辑改动一条要点（将相关提交合并为一条）
- 跳过合并提交和无关紧要的依赖升级，除非影响重大
- 每条要点末尾用括号附上提交短哈希，例如 (abc1234)
- 每条要点保持一句话，简洁明了
- 不要包含标题或版本号 — 只输出上述章节
- 所有人类可读内容必须使用简体中文

提交记录：
"#;

/// The changelog prompt for `language`.
pub fn changelog_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        CHANGELOG_PROMPT_ZH
    } else {
        CHANGELOG_PROMPT
    }
}

// ========================================================================
// Phase 3: "Local Bouncer" types and prompts
// ========================================================================

/// Risk level for staged changes analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

/// Category of an analysis finding
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingCategory {
    Secret,
    Complexity,
    Quality,
}

/// Severity of an analysis finding
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

/// A single finding from staged changes analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFinding {
    pub category: FindingCategory,
    pub severity: Severity,
    pub message: String,
    pub file_path: Option<String>,
}

/// Result of analyzing staged changes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAnalysis {
    pub findings: Vec<AnalysisFinding>,
    pub summary: String,
    pub risk_level: RiskLevel,
    /// Whether the AI half of the check actually ran and parsed.
    ///
    /// `serde(default)`: this same struct is what the MODEL's JSON is parsed
    /// into, and the model does not report on its own liveness. Without the
    /// default a missing field would fail the parse and take the AI pass down
    /// with it — the very failure this field exists to report.
    ///
    /// The regex secret scan always runs; the AI pass can fail (provider
    /// stopped after the availability check, model missing, network down,
    /// unparseable response). Both failures used to be discarded, so a check
    /// that had done nothing but grep for secrets still reported "No issues
    /// found" — false assurance that a review had happened.
    #[serde(default)]
    pub ai_analysis_ran: bool,
    /// Why the AI pass did not run, when it did not.
    #[serde(default)]
    pub ai_error: Option<String>,
}

/// Generated PR description result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPrDescription {
    pub body: String,
}

/// A group of files that should be committed together
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitGroup {
    pub label: String,
    pub files: Vec<String>,
    pub suggested_message: String,
}

/// Suggestion for splitting staged changes into multiple commits
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSplitSuggestion {
    pub should_split: bool,
    pub groups: Vec<CommitGroup>,
    pub explanation: String,
}

/// System prompt for pre-commit "vibe check"
pub const VIBE_CHECK_PROMPT: &str = r#"Analyze the following git diff for potential issues. Return ONLY a JSON object (no markdown fences) with this structure:
{"findings": [{"category": "secret|complexity|quality", "severity": "info|warning|error", "message": "description", "filePath": "path/to/file or null"}], "summary": "one-line summary", "riskLevel": "low|medium|high"}

Check for:
1. **Secrets**: Hardcoded API keys, tokens, passwords, connection strings, private keys
2. **Complexity**: Functions that grew very large, deeply nested logic, high cyclomatic complexity
3. **Quality**: Missing error handling, TODO/FIXME comments added, console.log/println left in

Rules:
- Be concise — one sentence per finding
- Only flag genuine issues, not false positives
- If no issues found, return empty findings array with riskLevel "low"
- filePath should be the file path from the diff header (a/path or b/path)

Diff:
"#;

/// Chinese (Simplified) variant of [`VIBE_CHECK_PROMPT`].
///
/// The JSON keys and the `category` / `severity` / `riskLevel` enum values are
/// the wire format the parser reads, so they stay English; only the free-text
/// `message` and `summary` values are Chinese.
pub const VIBE_CHECK_PROMPT_ZH: &str = r#"分析以下 git diff 中可能存在的问题。只返回一个 JSON 对象（不要 markdown 代码块），结构如下：
{"findings": [{"category": "secret|complexity|quality", "severity": "info|warning|error", "message": "问题描述", "filePath": "path/to/file 或 null"}], "summary": "一句话总结", "riskLevel": "low|medium|high"}

请检查：
1. **密钥**：硬编码的 API key、token、密码、连接字符串、私钥
2. **复杂度**：函数变得过于庞大、嵌套过深、圈复杂度过高
3. **质量**：缺少错误处理、新增的 TODO/FIXME 注释、遗留的 console.log/println

规则：
- 简洁 — 每个发现一句话
- 只报告真实问题，不要误报
- 如果没有发现问题，返回空的 findings 数组，riskLevel 为 "low"
- filePath 必须使用 diff 头中的文件路径（a/path 或 b/path）
- JSON 的键名以及 category/severity/riskLevel 的取值必须保持上面给出的英文形式，不得翻译
- message 和 summary 等所有人类可读内容必须使用简体中文

Diff:
"#;

/// The pre-commit "vibe check" prompt for `language`.
pub fn vibe_check_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        VIBE_CHECK_PROMPT_ZH
    } else {
        VIBE_CHECK_PROMPT
    }
}

/// System prompt for PR description generation
pub const PR_DESCRIPTION_PROMPT: &str = r#"Generate a pull request description in Markdown based on the following commits and diff statistics. Return ONLY the markdown body (no JSON wrapper).

Structure:
## Summary
2-3 sentences describing what this PR does and why.

## Changes
- Bulleted list of changes grouped by area (frontend, backend, tests, config)
- One bullet per logical change

## Test Plan
- What should be tested
- Any areas of risk

Rules:
- Focus on "what" and "why", not "how"
- Keep it concise — no more than 15 bullets total
- Use present tense ("Adds", "Fixes", "Updates")

PR Title: {title}

Commits and stats:
"#;

/// Chinese (Simplified) variant of [`PR_DESCRIPTION_PROMPT`].
///
/// Keeps the `{title}` placeholder that the command replaces before sending.
pub const PR_DESCRIPTION_PROMPT_ZH: &str = r#"根据以下提交记录和 diff 统计，生成 Markdown 格式的 Pull Request 描述。只返回 Markdown 正文（不要 JSON 包装）。

结构：
## 摘要
用 2-3 句话描述这个 PR 做了什么以及为什么。

## 变更
- 按领域（前端、后端、测试、配置）分组的变更要点列表
- 每个逻辑改动一条要点

## 测试计划
- 需要测试的内容
- 任何风险区域

规则：
- 关注"做了什么"和"为什么"，而不是"怎么做"
- 保持简洁 — 要点总数不超过 15 条
- 使用现在时（"新增"、"修复"、"更新"）
- 所有人类可读内容必须使用简体中文

PR 标题：{title}

提交记录和统计：
"#;

/// The PR-description prompt for `language`.
pub fn pr_description_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        PR_DESCRIPTION_PROMPT_ZH
    } else {
        PR_DESCRIPTION_PROMPT
    }
}

/// System prompt for tangled commit detection
pub const COMMIT_SPLIT_PROMPT: &str = r#"Analyze the following staged diff and determine if it contains multiple logically separate concerns that should be split into separate commits.

Return ONLY a JSON object (no markdown fences):
{"shouldSplit": true|false, "groups": [{"label": "short description", "files": ["path1", "path2"], "suggestedMessage": "conventional commit message"}], "explanation": "why splitting is recommended or why changes are cohesive"}

Rules:
- Only suggest splitting if there are genuinely separate concerns (e.g., a bug fix mixed with a refactor, or a feature addition mixed with test updates for unrelated code)
- Touching multiple files does NOT mean it should be split — related changes across files are normal
- If changes are cohesive, set shouldSplit to false with an empty groups array
- Each group's suggestedMessage should follow conventional commit format (feat:, fix:, refactor:, test:, docs:, chore:)
- File paths should match the paths in the diff headers

Diff:
"#;

/// Chinese (Simplified) variant of [`COMMIT_SPLIT_PROMPT`].
///
/// JSON keys and the conventional-commit type prefixes stay English.
pub const COMMIT_SPLIT_PROMPT_ZH: &str = r#"分析以下已暂存的 diff，判断其中是否包含多个在逻辑上相互独立的改动、需要拆分成多个提交。

只返回一个 JSON 对象（不要 markdown 代码块）：
{"shouldSplit": true|false, "groups": [{"label": "简短描述", "files": ["path1", "path2"], "suggestedMessage": "约定式提交信息"}], "explanation": "为什么建议拆分，或者为什么这些改动是内聚的"}

规则：
- 只有在确实存在相互独立的关注点时（例如缺陷修复混入了重构，或新增功能混入了不相关的测试改动）才建议拆分
- 修改多个文件并不意味着需要拆分 — 跨文件的相关改动是正常的
- 如果改动是内聚的，将 shouldSplit 设为 false，groups 为空数组
- 每个分组的 suggestedMessage 应遵循约定式提交格式（feat:, fix:, refactor:, test:, docs:, chore:）
- 文件路径应与 diff 头中的路径一致
- JSON 的键名和提交类型前缀必须保持英文形式，不得翻译
- label、explanation 等所有人类可读内容必须使用简体中文

Diff:
"#;

/// The tangled-commit-detection prompt for `language`.
pub fn commit_split_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        COMMIT_SPLIT_PROMPT_ZH
    } else {
        COMMIT_SPLIT_PROMPT
    }
}

/// System prompt for AI-powered conflict resolution
pub const CONFLICT_RESOLUTION_PROMPT: &str = r#"You are a merge conflict resolution assistant. You will be given the "ours" (current branch) and "theirs" (incoming branch) versions of a conflicting code section, optionally with a common ancestor "base" version and surrounding context.

Your task is to produce a single, correct, merged version that:
1. Preserves the intent of both changes when possible
2. Resolves any contradictions intelligently based on code context
3. Maintains correct syntax, indentation, and style consistent with the file

Respond with ONLY a JSON object (no markdown code fences) in this format:
{"resolvedContent": "the merged code here", "explanation": "brief explanation of how you resolved the conflict"}

Do NOT include conflict markers (<<<<<<, =======, >>>>>>>) in the resolved content."#;

/// Chinese (Simplified) variant of [`CONFLICT_RESOLUTION_PROMPT`].
///
/// `resolvedContent` is code and keeps the file's own language; `explanation`
/// is the human-visible value that must be Simplified Chinese.
pub const CONFLICT_RESOLUTION_PROMPT_ZH: &str = r#"你是一名合并冲突解决助手。你会收到冲突代码段的 "ours"（当前分支）和 "theirs"（合入分支）版本，可能还会收到共同祖先 "base" 版本以及周边上下文。

你的任务是产出一个单一、正确的合并版本，要求：
1. 尽可能保留双方改动的意图
2. 基于代码上下文智能地解决任何矛盾
3. 保持正确的语法、缩进，以及与文件一致的风格

只返回一个 JSON 对象（不要 markdown 代码块），格式如下：
{"resolvedContent": "合并后的代码", "explanation": "简要说明你是如何解决这个冲突的"}

resolvedContent 是合并后的代码本身，不要包含冲突标记（<<<<<<, =======, >>>>>>>）。explanation 等所有人类可读内容必须使用简体中文，JSON 键名保持英文。"#;

/// The conflict-resolution prompt for `language`.
pub fn conflict_resolution_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        CONFLICT_RESOLUTION_PROMPT_ZH
    } else {
        CONFLICT_RESOLUTION_PROMPT
    }
}

// ========================================================================
// Phase 4: "Rebase Pilot" types and prompts
// ========================================================================

/// AI-generated conflict explanation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictExplanation {
    pub explanation: String,
    pub ours_summary: String,
    pub theirs_summary: String,
}

/// Result of a predictive rebase preview
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePreview {
    pub total_commits: usize,
    pub clean_commits: usize,
    pub conflicting_commits: usize,
    pub conflicts: Vec<PredictedConflict>,
}

/// A predicted conflict from a ghost rebase
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedConflict {
    pub file_path: String,
    pub commit_summary: String,
}

/// Result of matching a natural language query to a reflog entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogMatch {
    pub index: usize,
    pub description: String,
}

/// System prompt for conflict explanation
pub const CONFLICT_EXPLAIN_PROMPT: &str = r#"You are a git merge conflict analyst. Explain why this conflict occurred in plain language.

Return ONLY a JSON object (no markdown fences):
{"explanation": "plain language explanation of why the conflict exists", "oursSummary": "what the current branch changed", "theirsSummary": "what the incoming branch changed"}

Rules:
- Be concise — 1-2 sentences each
- Focus on the semantic intent, not line-by-line differences
- Use the branch names if provided
- Mention if the changes are compatible (can coexist) or contradictory

"#;

/// Chinese (Simplified) variant of [`CONFLICT_EXPLAIN_PROMPT`].
pub const CONFLICT_EXPLAIN_PROMPT_ZH: &str = r#"你是一名 git 合并冲突分析师。请用通俗的语言解释这个冲突为什么会发生。

只返回一个 JSON 对象（不要 markdown 代码块）：
{"explanation": "用通俗语言解释冲突存在的原因", "oursSummary": "当前分支改动了什么", "theirsSummary": "合入分支改动了什么"}

规则：
- 简洁 — 每项 1-2 句话
- 关注语义意图，而不是逐行差异
- 如果提供了分支名就使用分支名
- 说明双方改动是兼容的（可以共存）还是相互矛盾的
- JSON 键名保持英文；explanation、oursSummary、theirsSummary 等所有人类可读内容必须使用简体中文

"#;

/// The conflict-explanation prompt for `language`.
pub fn conflict_explain_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        CONFLICT_EXPLAIN_PROMPT_ZH
    } else {
        CONFLICT_EXPLAIN_PROMPT
    }
}

/// System prompt for reflog entry matching
pub const REFLOG_MATCH_PROMPT: &str = r#"Given the following git reflog entries and a user's natural language request, identify which reflog entry best matches their intent.

Return ONLY a JSON object (no markdown fences):
{"index": <reflog_index_number>, "description": "human-readable description of what resetting to this state will do"}

Rules:
- Match the user's intent to the closest reflog entry
- For time-based queries ("10 minutes ago"), match by timestamp
- For action-based queries ("before the rebase"), find the entry just before that action
- For count-based queries ("undo last 3 commits"), count back from HEAD
- The description should explain what will change in plain language

User request: {query}

Reflog:
"#;

/// Chinese (Simplified) variant of [`REFLOG_MATCH_PROMPT`].
///
/// Keeps the `{query}` placeholder the command replaces before sending.
pub const REFLOG_MATCH_PROMPT_ZH: &str = r#"给定以下 git reflog 记录以及用户的自然语言请求，找出最符合其意图的 reflog 记录。

只返回一个 JSON 对象（不要 markdown 代码块）：
{"index": <reflog 索引编号>, "description": "重置到该状态后会发生什么的通俗描述"}

规则：
- 将用户意图匹配到最接近的 reflog 记录
- 对于基于时间的查询（"10 分钟前"），按时间戳匹配
- 对于基于操作的查询（"rebase 之前"），找到该操作之前的那条记录
- 对于基于数量的查询（"撤销最近 3 次提交"），从 HEAD 往前数
- description 应该用通俗语言说明会发生什么变化
- JSON 键名保持英文；description 必须使用简体中文

用户请求：{query}

Reflog:
"#;

/// The reflog-matching prompt for `language`.
pub fn reflog_match_prompt(language: PromptLanguage) -> &'static str {
    if language.is_zh() {
        REFLOG_MATCH_PROMPT_ZH
    } else {
        REFLOG_MATCH_PROMPT
    }
}

/// AI Service managing providers and configuration
pub struct AiService {
    config_dir: PathBuf,
    config: AiConfig,
    providers: HashMap<AiProviderType, Box<dyn AiProvider>>,
    /// Shared reference to the local inference provider (for loading models)
    local_provider: LocalInferenceProvider,
    /// Shared local AI state for lazy model loading
    local_ai_state: Option<SharedLocalAiState>,
}

impl AiService {
    /// Create a new AI service
    pub fn new(config_dir: PathBuf) -> Self {
        let config = AiConfig::load(&config_dir).unwrap_or_default();

        let mut service = Self {
            config_dir,
            config,
            providers: HashMap::new(),
            local_provider: LocalInferenceProvider::new(),
            local_ai_state: None,
        };

        // Initialize providers
        service.init_providers();

        service
    }

    /// Initialize all providers
    fn init_providers(&mut self) {
        // Ollama provider
        let ollama_settings = self
            .config
            .providers
            .get(&AiProviderType::Ollama)
            .cloned()
            .unwrap_or_default();
        let ollama = OllamaProvider::new(
            ollama_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::Ollama.default_endpoint().to_string()),
        );
        self.providers
            .insert(AiProviderType::Ollama, Box::new(ollama));

        // LM Studio provider (OpenAI compatible)
        let lm_settings = self
            .config
            .providers
            .get(&AiProviderType::LmStudio)
            .cloned()
            .unwrap_or_default();
        let lm_studio = OpenAiCompatibleProvider::new(
            AiProviderType::LmStudio,
            "LM Studio".to_string(),
            lm_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::LmStudio.default_endpoint().to_string()),
            None, // No API key for local
        );
        self.providers
            .insert(AiProviderType::LmStudio, Box::new(lm_studio));

        // OpenAI provider
        let openai_settings = self
            .config
            .providers
            .get(&AiProviderType::OpenAi)
            .cloned()
            .unwrap_or_default();
        let openai = OpenAiCompatibleProvider::new(
            AiProviderType::OpenAi,
            "OpenAI".to_string(),
            openai_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::OpenAi.default_endpoint().to_string()),
            openai_settings.api_key,
        );
        self.providers
            .insert(AiProviderType::OpenAi, Box::new(openai));

        // Anthropic provider
        let anthropic_settings = self
            .config
            .providers
            .get(&AiProviderType::Anthropic)
            .cloned()
            .unwrap_or_default();
        let anthropic = AnthropicProvider::new(
            anthropic_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::Anthropic.default_endpoint().to_string()),
            anthropic_settings.api_key,
        );
        self.providers
            .insert(AiProviderType::Anthropic, Box::new(anthropic));

        // GitHub Copilot provider
        let copilot_settings = self
            .config
            .providers
            .get(&AiProviderType::GithubCopilot)
            .cloned()
            .unwrap_or_default();
        let copilot = GithubCopilotProvider::new(
            copilot_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::GithubCopilot.default_endpoint().to_string()),
            copilot_settings.api_key,
        );
        self.providers
            .insert(AiProviderType::GithubCopilot, Box::new(copilot));

        // Google Gemini provider
        let gemini_settings = self
            .config
            .providers
            .get(&AiProviderType::GoogleGemini)
            .cloned()
            .unwrap_or_default();
        let gemini = GeminiProvider::new(
            gemini_settings
                .endpoint
                .unwrap_or_else(|| AiProviderType::GoogleGemini.default_endpoint().to_string()),
            gemini_settings.api_key,
        );
        self.providers
            .insert(AiProviderType::GoogleGemini, Box::new(gemini));

        // Local inference provider — reuse shared instance to preserve loaded engine
        self.providers.insert(
            AiProviderType::LocalInference,
            Box::new(self.local_provider.clone()),
        );
    }

    /// Get the local model status
    pub async fn get_local_model_status(&self) -> providers::LocalModelStatus {
        self.local_provider.get_status().await
    }

    /// Get the display name of the currently loaded local model, if any.
    pub async fn get_loaded_model_name(&self) -> Option<String> {
        self.local_provider.get_model_name().await
    }

    /// Get the current configuration
    pub fn get_config(&self) -> &AiConfig {
        &self.config
    }

    /// The endpoint a provider would be contacted on.
    pub fn endpoint_for(&self, provider_type: AiProviderType) -> String {
        self.config
            .providers
            .get(&provider_type)
            .and_then(|s| s.endpoint.clone())
            .unwrap_or_else(|| provider_type.default_endpoint().to_string())
    }

    /// Whether a request to `provider_type` is permitted by the security
    /// settings. A provider on loopback (Ollama, LM Studio) or with no endpoint
    /// at all (the embedded model) never leaves the machine and stays usable
    /// with offline mode on — that is the whole point of running one.
    pub fn provider_network_allowed(&self, provider_type: AiProviderType) -> bool {
        crate::services::security::endpoint_allowed(&self.endpoint_for(provider_type))
    }

    /// The endpoint of the provider chosen in Settings, or `None` when nothing
    /// is chosen and a request would fall back to whatever is reachable.
    pub fn active_provider_endpoint(&self) -> Option<String> {
        self.config.active_provider.map(|pt| self.endpoint_for(pt))
    }

    /// Get information about all providers
    pub async fn get_providers_info(&self) -> Vec<AiProviderInfo> {
        let mut infos = Vec::new();

        for provider_type in AiProviderType::all() {
            if let Some(provider) = self.providers.get(&provider_type) {
                let settings = self.config.providers.get(&provider_type);
                // Probing is itself a network request for a cloud provider, and
                // this list is what Settings renders — including the switch the
                // user needs in order to turn that provider off. So when the
                // security settings forbid reaching it, report it unprobed
                // instead of reaching out or hiding it.
                let probed = self.provider_network_allowed(provider_type);
                let (available, models) = if probed {
                    (
                        provider.is_available().await,
                        provider.list_models().await.unwrap_or_default(),
                    )
                } else {
                    (false, Vec::new())
                };

                infos.push(AiProviderInfo {
                    provider_type,
                    name: provider.name().to_string(),
                    available,
                    probed,
                    requires_api_key: provider_type.requires_api_key(),
                    has_api_key: settings.and_then(|s| s.api_key.as_ref()).is_some(),
                    endpoint: settings
                        .and_then(|s| s.endpoint.clone())
                        .unwrap_or_else(|| provider_type.default_endpoint().to_string()),
                    models,
                    selected_model: settings.and_then(|s| s.model.clone()),
                });
            }
        }

        infos
    }

    /// Set the active provider
    pub fn set_active_provider(&mut self, provider_type: AiProviderType) -> Result<(), String> {
        self.config.active_provider = Some(provider_type);
        self.save_config()
    }

    /// Set API key for a provider
    pub fn set_api_key(
        &mut self,
        provider_type: AiProviderType,
        api_key: Option<String>,
    ) -> Result<(), String> {
        let has_key = api_key.is_some();
        let settings = self.config.providers.entry(provider_type).or_default();
        settings.api_key = api_key;

        // Auto-select this provider if none is active and a key was provided
        if has_key && self.config.active_provider.is_none() {
            self.config.active_provider = Some(provider_type);
        }

        // Reinitialize providers to pick up new key
        self.init_providers();
        self.save_config()
    }

    /// Set the model for a provider
    pub fn set_model(
        &mut self,
        provider_type: AiProviderType,
        model: Option<String>,
    ) -> Result<(), String> {
        let settings = self.config.providers.entry(provider_type).or_default();
        settings.model = model;
        self.save_config()
    }

    /// Set custom endpoint for a provider
    pub fn set_endpoint(
        &mut self,
        provider_type: AiProviderType,
        endpoint: Option<String>,
    ) -> Result<(), String> {
        let settings = self.config.providers.entry(provider_type).or_default();
        settings.endpoint = endpoint;

        // Reinitialize providers to use new endpoint
        self.init_providers();
        self.save_config()
    }

    /// Set the shared local AI state reference for lazy model loading.
    /// Must be called after both AiState and SharedLocalAiState are created.
    pub fn set_local_ai_state(&mut self, state: SharedLocalAiState) {
        self.local_ai_state = Some(state);
    }

    /// Lazily load a local GGUF model if one is downloaded but not yet loaded.
    ///
    /// This defers model loading to avoid startup race conditions:
    /// instead of loading the model at startup (which could race with other
    /// initialization), we defer loading until the first inference request.
    pub async fn ensure_local_model_loaded(&self) -> Result<(), String> {
        // Already loaded or loading — nothing to do
        let status = self.local_provider.get_status().await;
        if status == providers::LocalModelStatus::Ready
            || status == providers::LocalModelStatus::Loading
        {
            return Ok(());
        }

        let local_state = match &self.local_ai_state {
            Some(s) => s.clone(),
            None => return Err("Local AI state not available".to_string()),
        };

        let local = local_state.read().await;
        let downloaded = local.model_manager.list_downloaded().unwrap_or_default();

        // Pick the first model whose GGUF file is actually on disk and look up
        // its registry entry. A directory left with only its metadata cannot be
        // loaded, and trying would leave the provider stuck in the error state.
        let model = match downloaded
            .iter()
            .find(|m| m.status == local::model_manager::ModelStatus::Downloaded)
        {
            Some(m) => m,
            None => return Ok(()), // Nothing loadable — nothing to do
        };
        let meta = local
            .registry
            .get_by_id(&model.id)
            .map(|entry| providers::LoadedModelMeta {
                tier: entry.tier,
                architecture: entry.architecture.clone(),
                context_length: entry.context_length,
            })
            .or_else(|| {
                local.model_manager.get_downloaded_meta(&model.id).map(
                    |(_display_name, architecture, context_length)| providers::LoadedModelMeta {
                        tier: local::ModelTier::Standard,
                        architecture,
                        context_length,
                    },
                )
            });
        let model_path = model.path.clone();
        let display_name = model.display_name.clone();
        drop(local);

        tracing::info!("Lazy-loading local model: {}", display_name);
        self.load_local_model(&model_path, display_name, meta).await
    }

    /// True if a downloaded local model is waiting to be lazy-loaded.
    ///
    /// The GGUF file must be present: a model directory left with only its
    /// metadata is not loadable, so it does not count. `list_downloaded` also
    /// ignores in-flight downloads, whose metadata is written last.
    pub async fn has_loadable_local_model(&self) -> bool {
        let local_state = match &self.local_ai_state {
            Some(s) => s,
            None => return false,
        };
        let local = local_state.read().await;
        local
            .model_manager
            .list_downloaded()
            .unwrap_or_default()
            .iter()
            .any(|m| m.status == local::model_manager::ModelStatus::Downloaded)
    }

    /// True when local inference is the provider a request would be served by:
    /// it is the choice made in Settings, or nothing has been chosen and the
    /// scan below tries local inference first.
    fn local_inference_would_serve(&self) -> bool {
        matches!(
            self.config.active_provider,
            None | Some(AiProviderType::LocalInference)
        )
    }

    /// Why an AI request would fail right now, or `None` if it would succeed.
    ///
    /// A downloaded-but-unloaded local model counts as available: the model is
    /// only ever loaded on demand (see [`AiService::ensure_local_model_loaded`]),
    /// never at startup, so reporting it as unavailable would hide AI features
    /// that do in fact work after every restart. That only holds when local
    /// inference is the provider a request would actually use — a provider
    /// chosen in Settings is never substituted, so a downloaded model does not
    /// make some other unavailable choice work.
    pub async fn unavailable_reason(&self) -> Option<String> {
        match self.resolve_provider().await {
            Ok(_) => None,
            Err(reason) => {
                if self.local_inference_would_serve() && self.has_loadable_local_model().await {
                    None
                } else {
                    Some(reason)
                }
            }
        }
    }

    /// Whether an AI request would succeed right now.
    pub async fn has_available_provider(&self) -> bool {
        self.unavailable_reason().await.is_none()
    }

    /// Resolve the provider that will serve a request, loading the local model
    /// only when it is the model that will actually answer.
    ///
    /// A choice made in Settings is honoured exactly: when the chosen provider
    /// is unavailable the request fails naming it instead of quietly going
    /// somewhere else, so a diff never reaches a provider the user did not
    /// pick — and a downloaded-but-unloaded local model is never loaded on
    /// behalf of a *different* chosen provider that happens to be down.
    /// Loading a GGUF costs gigabytes of RAM/GPU, so the load is only
    /// attempted when local inference is the provider that could actually
    /// serve: it is the explicit choice, or nothing has been chosen and the
    /// scan below tries local inference first. The scan across every other
    /// provider applies only when nothing has been chosen.
    pub async fn resolve_provider(&self) -> Result<(&dyn AiProvider, AiProviderType), String> {
        if let Some(pt) = self.config.active_provider {
            if pt == AiProviderType::LocalInference {
                // Deferred from startup to avoid races; loaded here since the
                // user chose this provider explicitly.
                if let Err(e) = self.ensure_local_model_loaded().await {
                    tracing::debug!("Lazy model load skipped: {}", e);
                }
            }

            // A provider the security settings forbid reaching is not probed
            // and not used, whatever its state.
            if self.provider_network_allowed(pt) {
                if let Some(provider) = self.providers.get(&pt) {
                    if provider.is_available().await {
                        return Ok((provider.as_ref(), pt));
                    }
                }
            } else {
                return Err(format!(
                    "{} is at {}, which your security settings do not allow reaching. \
                     Turn off offline mode or allowlist its host in Settings > Security, \
                     or select a local provider.",
                    pt.display_name(),
                    self.endpoint_for(pt)
                ));
            }

            let hint = match pt {
                AiProviderType::LocalInference => {
                    "Please download and load a model in Settings > Local AI, or select a different provider."
                }
                _ if pt.requires_api_key() => {
                    "Please check its API key in Settings, or select a different provider."
                }
                _ => "Please make sure it is running, or select a different provider in Settings.",
            };
            return Err(format!("{} is not available. {}", pt.display_name(), hint));
        }

        // Nothing chosen — use whatever is reachable. Local inference ranks
        // above every other fallback, so it gets first refusal: load it now,
        // deferred from startup to avoid races.
        if let Err(e) = self.ensure_local_model_loaded().await {
            tracing::debug!("Lazy model load skipped: {}", e);
        }
        if let Some(provider) = self.providers.get(&AiProviderType::LocalInference) {
            if provider.is_available().await {
                return Ok((provider.as_ref(), AiProviderType::LocalInference));
            }
        }

        // Fall back to any other available provider, in a deterministic order.
        // Iterating `self.providers` (a HashMap) directly would pick an
        // unpredictable provider across runs when several have keys configured.
        for pt in AiProviderType::all() {
            if pt == AiProviderType::LocalInference {
                continue; // Already checked above
            }
            // Skipped rather than probed: the scan runs on every availability
            // check, so probing a forbidden host here would leak a request per
            // check even with offline mode on.
            if !self.provider_network_allowed(pt) {
                continue;
            }
            if let Some(provider) = self.providers.get(&pt) {
                if provider.is_available().await {
                    return Ok((provider.as_ref(), pt));
                }
            }
        }

        Err("No AI provider available. Please configure a provider in Settings.".to_string())
    }

    /// Find the provider that will serve a request, if any.
    ///
    /// Thin wrapper over [`AiService::resolve_provider`] for callers that only
    /// need to know whether AI is usable: availability has to answer for the
    /// same provider a request would actually use.
    pub async fn find_available_provider(&self) -> Option<(&dyn AiProvider, AiProviderType)> {
        self.resolve_provider().await.ok()
    }

    /// Save configuration to disk
    fn save_config(&self) -> Result<(), String> {
        self.config.save(&self.config_dir)
    }

    /// Test if a provider is available
    pub async fn test_provider(&self, provider_type: AiProviderType) -> Result<bool, String> {
        let provider = self
            .providers
            .get(&provider_type)
            .ok_or_else(|| format!("Provider {:?} not found", provider_type))?;

        Ok(provider.is_available().await)
    }

    /// Generate a commit message using the active provider.
    ///
    /// `language` is threaded all the way to the provider so the summary and
    /// body are written in the language chosen in Settings.
    pub async fn generate_commit_message(
        &self,
        diff: String,
        language: PromptLanguage,
    ) -> Result<GeneratedCommitMessage, String> {
        let (provider, provider_type) = self.resolve_provider().await?;

        // Truncate diff if too long (skip for local inference — it handles
        // per-file truncation internally and needs all files for good summaries)
        let truncated_diff = if provider_type == AiProviderType::LocalInference {
            diff
        } else if diff.len() > MAX_DIFF_BYTES {
            format!(
                "{}...\n[Diff truncated for length]",
                truncate_at_char_boundary(&diff, MAX_DIFF_BYTES)
            )
        } else {
            diff
        };

        // Get the selected model for this provider
        let model = self
            .config
            .providers
            .get(&provider_type)
            .and_then(|s| s.model.as_deref());

        provider
            .generate_commit_message(&truncated_diff, model, language)
            .await
    }

    /// Generate free-form text using the active provider
    pub async fn generate_text(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: Option<u32>,
    ) -> Result<String, String> {
        let (provider, provider_type) = self.resolve_provider().await?;

        // Get the selected model for this provider
        let model = self
            .config
            .providers
            .get(&provider_type)
            .and_then(|s| s.model.as_deref());

        provider
            .generate_text(system_prompt, user_prompt, model, max_tokens)
            .await
    }

    /// Load a GGUF model into the local inference engine.
    ///
    /// After loading, the local inference provider will report as available
    /// and can be used for commit message generation and conflict resolution.
    pub async fn load_local_model(
        &self,
        model_path: &std::path::Path,
        model_name: String,
        meta: Option<providers::LoadedModelMeta>,
    ) -> Result<(), String> {
        // Guard: skip if a model is already loading or ready
        let status = self.local_provider.get_status().await;
        if status == providers::LocalModelStatus::Loading {
            return Err("A model is already being loaded".to_string());
        }
        if status == providers::LocalModelStatus::Ready {
            tracing::info!("Replacing currently loaded model with '{}'", model_name);
        }

        self.local_provider.set_loading().await;

        let model_path = model_path.to_path_buf();

        // Run the heavy GGUF loading on a blocking thread to avoid freezing the async runtime
        let result = tokio::task::spawn_blocking(move || {
            local::GgufEngine::load(&model_path, model_name, meta)
        })
        .await
        .map_err(|e| format!("Model loading task failed: {e}"))?;

        match result {
            Ok(engine) => {
                self.local_provider.set_engine(Box::new(engine)).await;
                tracing::info!("Local inference engine loaded and ready");

                // Best-effort warm-up: the first generation after a load pays
                // for llama.cpp's kernel/context setup and the model's first
                // prompt eval, which is a noticeable part of first-token
                // latency for the small token budgets used per file. Run it in
                // the background so loading still returns immediately, and
                // never let its failure fail the load — a warm-up that fails
                // is only a slower first request.
                let provider = self.local_provider.clone();
                tokio::spawn(async move {
                    match provider.warm_up().await {
                        Ok(()) => tracing::debug!("Local model warm-up completed"),
                        Err(e) => tracing::debug!("Local model warm-up failed (ignored): {e}"),
                    }
                });

                Ok(())
            }
            Err(e) => {
                self.local_provider.set_error().await;
                Err(e)
            }
        }
    }

    /// Unload the current local model
    pub async fn unload_local_model(&self) {
        self.local_provider.clear_engine().await;
    }

    /// Auto-detect available local providers
    pub async fn auto_detect_providers(&self) -> Vec<AiProviderType> {
        let mut available = Vec::new();

        for provider_type in [AiProviderType::Ollama, AiProviderType::LmStudio] {
            // Normally loopback and therefore always probeable, but either can
            // be pointed at a remote host in Settings.
            if !self.provider_network_allowed(provider_type) {
                continue;
            }
            if let Some(provider) = self.providers.get(&provider_type) {
                if provider.is_available().await {
                    available.push(provider_type);
                }
            }
        }

        available
    }
}

/// Global AI service state
pub type AiState = Arc<RwLock<AiService>>;

/// Truncate at or before `max_bytes` without splitting a UTF-8 character.
///
/// Slicing a `&str` at a byte index that is not a char boundary panics. The
/// truncation limits here are byte counts, so any diff or commit log over the
/// limit that contains non-ASCII text — comments, names, emoji, all routine in
/// real repositories — could land the cut mid-character and kill the command
/// task outright, leaving "Generate commit message" and "Vibe Check" dead for
/// that user whenever their diff was large.
pub(crate) fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }

    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Create the AI service state
pub fn create_ai_state(config_dir: PathBuf) -> AiState {
    Arc::new(RwLock::new(AiService::new(config_dir)))
}

#[cfg(test)]
mod tests {

    /// Truncation limits are BYTE counts, but slicing a &str at a byte index
    /// that is not a char boundary panics. A diff over the limit containing any
    /// non-ASCII text — comments, names, emoji, all routine — could land the cut
    /// mid-character and kill the command task.
    #[test]
    fn test_truncate_at_char_boundary_never_splits_a_character() {
        // é is two bytes, so every odd cut inside the string is mid-character.
        let s = "ééééééééé";
        assert_eq!(s.len(), 18);

        for max in 0..=s.len() {
            let out = truncate_at_char_boundary(s, max);
            assert!(out.len() <= max, "must not exceed the limit");
            assert!(s.starts_with(out), "must be a prefix");
            // Round-tripping through chars proves it is valid UTF-8 at the cut.
            assert_eq!(out.chars().count() * 2, out.len());
        }
    }

    #[test]
    fn test_truncate_at_char_boundary_handles_wide_characters() {
        // A 4-byte emoji: a cut anywhere inside it must fall back to before it.
        let s = "ab🎉cd";
        assert_eq!(truncate_at_char_boundary(s, 3), "ab");
        assert_eq!(truncate_at_char_boundary(s, 4), "ab");
        assert_eq!(truncate_at_char_boundary(s, 5), "ab");
        assert_eq!(truncate_at_char_boundary(s, 6), "ab🎉");
    }

    #[test]
    fn test_truncate_at_char_boundary_returns_short_input_unchanged() {
        assert_eq!(truncate_at_char_boundary("abc", 10), "abc");
        assert_eq!(truncate_at_char_boundary("abc", 3), "abc");
    }
    use super::*;
    use crate::services::security::test_support::no_policy;

    #[test]
    fn test_provider_type_display_name() {
        assert_eq!(AiProviderType::Ollama.display_name(), "Ollama");
        assert_eq!(AiProviderType::OpenAi.display_name(), "OpenAI");
        assert_eq!(AiProviderType::Anthropic.display_name(), "Anthropic Claude");
    }

    #[test]
    fn test_provider_type_requires_api_key() {
        assert!(!AiProviderType::Ollama.requires_api_key());
        assert!(!AiProviderType::LmStudio.requires_api_key());
        assert!(!AiProviderType::LocalInference.requires_api_key());
        assert!(AiProviderType::OpenAi.requires_api_key());
        assert!(AiProviderType::Anthropic.requires_api_key());
        assert!(AiProviderType::GoogleGemini.requires_api_key());
    }

    #[test]
    fn test_local_inference_provider_type() {
        assert_eq!(
            AiProviderType::LocalInference.display_name(),
            "Local AI (Embedded)"
        );
        assert_eq!(AiProviderType::LocalInference.default_model(), "local");
        assert_eq!(AiProviderType::LocalInference.default_endpoint(), "");
    }

    #[test]
    fn test_all_providers_includes_local() {
        let all = AiProviderType::all();
        assert!(all.contains(&AiProviderType::LocalInference));
        assert_eq!(all.len(), 7);
    }

    /// A provider that is always available and answers instantly, standing in
    /// for a configured cloud provider without touching the network.
    struct StubProvider;

    #[async_trait]
    impl AiProvider for StubProvider {
        fn provider_type(&self) -> AiProviderType {
            AiProviderType::Anthropic
        }

        fn name(&self) -> &str {
            "stub"
        }

        async fn is_available(&self) -> bool {
            true
        }

        async fn list_models(&self) -> Result<Vec<String>, String> {
            Ok(vec![])
        }

        async fn generate_commit_message(
            &self,
            _diff: &str,
            _model: Option<&str>,
            _language: PromptLanguage,
        ) -> Result<GeneratedCommitMessage, String> {
            Ok(GeneratedCommitMessage {
                summary: "feat: stub".to_string(),
                body: None,
            })
        }

        async fn generate_text(
            &self,
            _system_prompt: &str,
            _user_prompt: &str,
            _model: Option<&str>,
            _max_tokens: Option<u32>,
        ) -> Result<String, String> {
            Ok("stub text".to_string())
        }
    }

    /// Write a model directory that `list_downloaded` reports as downloaded,
    /// with a `model.gguf` that is not a valid GGUF so any attempted load fails
    /// fast. The engine leaving `Unloaded` is the observable "a load was
    /// attempted"; the load itself never succeeds.
    fn write_downloaded_model(models_dir: &std::path::Path) {
        let dir = models_dir.join("tiny-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("model_meta.json"),
            r#"{
                "id": "tiny-test",
                "displayName": "Tiny Test",
                "sizeBytes": 1,
                "sha256": "",
                "architecture": "llama",
                "contextLength": 512
            }"#,
        )
        .unwrap();
        std::fs::write(dir.join("model.gguf"), b"not a gguf file").unwrap();
    }

    /// An AiService with one downloaded-but-unloaded local model and no
    /// reachable network providers.
    async fn service_fixture() -> (AiService, tempfile::TempDir, tempfile::TempDir) {
        let config_dir = tempfile::tempdir().unwrap();
        let models_dir = tempfile::tempdir().unwrap();
        write_downloaded_model(models_dir.path());

        let mut service = AiService::new(config_dir.path().to_path_buf());
        service.set_local_ai_state(crate::commands::local_ai::create_local_ai_state(
            models_dir.path().to_path_buf(),
        ));
        // Point the endpoint-probing providers at a closed port so
        // `is_available` fails instantly and without leaving the machine.
        // These call `init_providers`, so they must precede any stub insert.
        service
            .set_endpoint(AiProviderType::Ollama, Some("http://127.0.0.1:1".into()))
            .unwrap();
        service
            .set_endpoint(AiProviderType::LmStudio, Some("http://127.0.0.1:1".into()))
            .unwrap();

        (service, config_dir, models_dir)
    }

    /// A downloaded GGUF must not be loaded into RAM/GPU when the active
    /// provider is a cloud one that is about to serve the request — that also
    /// silently undid the Settings "Unload" button on the next AI action.
    #[tokio::test]
    async fn test_generate_commit_message_does_not_load_local_when_another_provider_serves() {
        let _policy = no_policy();
        let (mut service, _config_dir, _models_dir) = service_fixture().await;
        service
            .set_active_provider(AiProviderType::Anthropic)
            .unwrap();
        service
            .providers
            .insert(AiProviderType::Anthropic, Box::new(StubProvider));

        let result = service
            .generate_commit_message("diff --git a/a b/a".to_string(), PromptLanguage::En)
            .await;

        assert_eq!(result.unwrap().summary, "feat: stub");
        assert_eq!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded,
            "no local model load may be attempted when another provider serves"
        );
    }

    /// `generate_text` backs changelog, vibe check, PR description and conflict
    /// explain, and had the same unconditional load.
    #[tokio::test]
    async fn test_generate_text_does_not_load_local_when_another_provider_serves() {
        let _policy = no_policy();
        let (mut service, _config_dir, _models_dir) = service_fixture().await;
        service
            .set_active_provider(AiProviderType::Anthropic)
            .unwrap();
        service
            .providers
            .insert(AiProviderType::Anthropic, Box::new(StubProvider));

        let result = service.generate_text("sys", "user", Some(100)).await;

        assert_eq!(result.unwrap(), "stub text");
        assert_eq!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded,
            "no local model load may be attempted when another provider serves"
        );
    }

    /// Guard against over-gating: with nothing else configured, the downloaded
    /// local model is still the candidate and must still be lazily loaded.
    #[tokio::test]
    async fn test_generate_commit_message_still_lazy_loads_local_when_nothing_else_available() {
        let _policy = no_policy();
        let (service, _config_dir, _models_dir) = service_fixture().await;

        let err = service
            .generate_commit_message("diff --git a/a b/a".to_string(), PromptLanguage::En)
            .await
            .unwrap_err();

        assert_eq!(
            err,
            "No AI provider available. Please configure a provider in Settings."
        );
        assert_ne!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded,
            "the local model is the only candidate, so a load must be attempted"
        );
    }

    /// When the user explicitly chose local inference, it is loaded even
    /// though another provider is configured — but a failed load must not
    /// silently substitute that other provider. Selecting a provider in
    /// Settings is honoured exactly, in both directions.
    #[tokio::test]
    async fn test_local_active_provider_is_loaded_and_errors_when_it_cannot_load() {
        let _policy = no_policy();
        let (mut service, _config_dir, _models_dir) = service_fixture().await;
        service
            .set_active_provider(AiProviderType::LocalInference)
            .unwrap();
        service
            .providers
            .insert(AiProviderType::Anthropic, Box::new(StubProvider));

        let err = service
            .generate_commit_message("diff --git a/a b/a".to_string(), PromptLanguage::En)
            .await
            .unwrap_err();

        assert_ne!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded,
            "the user's chosen local model must still be loaded"
        );
        assert!(err.contains("Local AI"), "{err}");
    }

    /// When a *different* provider is explicitly chosen and unreachable, the
    /// request must fail naming that provider — not silently substitute the
    /// local model. Loading a GGUF on its behalf would also undo an explicit
    /// Settings "Unload" the next time this provider comes back, and would
    /// perform a needless multi-gigabyte load for a provider the user never
    /// selected.
    #[tokio::test]
    async fn test_unavailable_active_provider_does_not_fall_back_to_local_model() {
        let _policy = no_policy();
        let (mut service, _config_dir, _models_dir) = service_fixture().await;
        // Ollama is the chosen provider but its endpoint is a closed port.
        service.set_active_provider(AiProviderType::Ollama).unwrap();
        // ...while a stale cloud key is still configured behind it.
        service
            .providers
            .insert(AiProviderType::Anthropic, Box::new(StubProvider));

        let err = service
            .generate_commit_message("diff --git a/a b/a".to_string(), PromptLanguage::En)
            .await
            .unwrap_err();

        assert_eq!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded,
            "a non-active local model must not be loaded on behalf of a different chosen provider"
        );
        assert!(err.contains("Ollama"), "{err}");
    }

    // --- Provider resolution -------------------------------------------------
    //
    // A provider picked in Settings is a privacy decision, not a preference:
    // falling through to a cloud provider whose key happens to be saved would
    // ship the staged diff, conflict contents or commit log somewhere the user
    // never chose. These tests pin that the choice is honoured exactly, and
    // that the scan still runs when nothing has been chosen.

    /// A service whose probing providers point at a closed port, so a real
    /// Ollama/LM Studio on the machine running the tests cannot be picked up.
    fn test_service(dir: &tempfile::TempDir) -> AiService {
        let mut service = AiService::new(dir.path().to_path_buf());
        for pt in [AiProviderType::Ollama, AiProviderType::LmStudio] {
            service.config.providers.entry(pt).or_default().endpoint =
                Some("http://127.0.0.1:1".to_string());
        }
        service.init_providers();
        service
    }

    fn set_key(service: &mut AiService, pt: AiProviderType, key: &str) {
        service.config.providers.entry(pt).or_default().api_key = Some(key.to_string());
        service.init_providers();
    }

    /// Point a keyed cloud provider at a closed port so that, if resolution
    /// ever did fall through to it, the failure stays on this machine.
    fn dead_end(service: &mut AiService, pt: AiProviderType) {
        service.config.providers.entry(pt).or_default().endpoint =
            Some("http://127.0.0.1:1".to_string());
        service.init_providers();
    }

    #[tokio::test]
    async fn resolve_provider_refuses_to_substitute_an_unchosen_provider() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");
        // Chosen provider has no key, so it is unavailable — while Gemini,
        // configured at some point in the past, reports available.
        service.config.active_provider = Some(AiProviderType::Anthropic);

        let err = service
            .resolve_provider()
            .await
            .map(|(_, pt)| pt)
            .unwrap_err();
        assert!(err.contains("Anthropic Claude"), "{err}");
        assert!(err.contains("Settings"), "{err}");
    }

    #[tokio::test]
    async fn generate_commit_message_never_hands_the_diff_to_a_substitute_provider() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");
        dead_end(&mut service, AiProviderType::GoogleGemini);
        service.config.active_provider = Some(AiProviderType::Anthropic);

        let err = service
            .generate_commit_message(
                "diff --git a/a.rs b/a.rs\n+secret\n".to_string(),
                PromptLanguage::En,
            )
            .await
            .unwrap_err();
        assert!(err.contains("Anthropic Claude"), "{err}");
        assert!(!err.to_lowercase().contains("gemini"), "{err}");
    }

    #[tokio::test]
    async fn generate_text_never_hands_the_prompt_to_a_substitute_provider() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");
        dead_end(&mut service, AiProviderType::GoogleGemini);
        service.config.active_provider = Some(AiProviderType::Anthropic);

        let err = service
            .generate_text(
                CONFLICT_RESOLUTION_PROMPT,
                "<<<<<<< ours\nsecret\n=======\ntheirs\n>>>>>>>",
                None,
            )
            .await
            .unwrap_err();
        assert!(err.contains("Anthropic Claude"), "{err}");
        assert!(!err.to_lowercase().contains("gemini"), "{err}");
    }

    #[tokio::test]
    async fn resolve_provider_error_points_at_the_local_model_step() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");
        // Local AI selected, no engine loaded.
        service.config.active_provider = Some(AiProviderType::LocalInference);

        let err = service
            .resolve_provider()
            .await
            .map(|(_, pt)| pt)
            .unwrap_err();
        assert!(err.contains("Settings > Local AI"), "{err}");
    }

    #[tokio::test]
    async fn resolve_provider_uses_the_provider_the_user_selected() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::Anthropic, "test-key");
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");
        service.config.active_provider = Some(AiProviderType::Anthropic);

        let (_, pt) = service
            .resolve_provider()
            .await
            .expect("chosen provider is available");
        assert_eq!(pt, AiProviderType::Anthropic);
    }

    #[tokio::test]
    async fn resolve_provider_still_scans_when_nothing_is_selected() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        assert!(service.config.active_provider.is_none());
        set_key(&mut service, AiProviderType::GoogleGemini, "test-key");

        let (_, pt) = service
            .resolve_provider()
            .await
            .expect("a configured provider should still be found");
        assert_eq!(pt, AiProviderType::GoogleGemini);
        assert!(service.find_available_provider().await.is_some());
    }

    // --- Local-model availability -------------------------------------------
    //
    // A local GGUF model is never loaded at startup (see
    // `ensure_local_model_loaded`): loading is deferred to the first inference
    // request. These tests pin that a downloaded-but-unloaded model still
    // reports as available, and that a half-deleted model directory does not.

    /// Build an `AiService` with no configured cloud provider, wired to a
    /// models directory under `models_dir`.
    fn service_with_models(models_dir: std::path::PathBuf) -> (AiService, tempfile::TempDir) {
        let config_dir = tempfile::tempdir().unwrap();
        let mut service = AiService::new(config_dir.path().to_path_buf());
        service.set_local_ai_state(crate::commands::local_ai::create_local_ai_state(models_dir));
        (service, config_dir)
    }

    /// Write a model directory the way `ModelManager` lays one out. Without the
    /// GGUF file it is the half-downloaded/half-deleted shape that
    /// `list_downloaded` reports as `ModelStatus::Error`.
    fn write_model(models_dir: &std::path::Path, id: &str, with_gguf: bool) {
        let model_dir = models_dir.join(id);
        std::fs::create_dir_all(&model_dir).unwrap();
        let meta = format!(
            r#"{{
                "id": "{id}",
                "displayName": "Test Model",
                "sizeBytes": 9,
                "sha256": "abc",
                "architecture": "test",
                "contextLength": 2048
            }}"#
        );
        std::fs::write(model_dir.join("model_meta.json"), meta).unwrap();
        if with_gguf {
            std::fs::write(model_dir.join("model.gguf"), b"fake data").unwrap();
        }
    }

    #[tokio::test]
    async fn test_downloaded_but_unloaded_local_model_counts_as_available() {
        let _policy = no_policy();
        let models = tempfile::tempdir().unwrap();
        write_model(models.path(), "ready-model", true);
        let (service, _cfg) = service_with_models(models.path().to_path_buf());

        // Nothing has been loaded: this is the state after every app restart.
        assert!(!service
            .test_provider(AiProviderType::LocalInference)
            .await
            .unwrap());
        assert_eq!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded
        );

        // ...yet a generate request would lazily load it and succeed, so the
        // `is_ai_available` command must not report AI as unconfigured.
        assert!(service.has_loadable_local_model().await);
        assert!(service.has_available_provider().await);
    }

    #[tokio::test]
    async fn test_no_downloaded_model_is_not_loadable() {
        // An empty models directory.
        let models = tempfile::tempdir().unwrap();
        let (service, _cfg) = service_with_models(models.path().to_path_buf());
        assert!(!service.has_loadable_local_model().await);

        // ...and the pre-wiring state, before `set_local_ai_state` is called.
        let config_dir = tempfile::tempdir().unwrap();
        let unwired = AiService::new(config_dir.path().to_path_buf());
        assert!(!unwired.has_loadable_local_model().await);
    }

    #[tokio::test]
    async fn test_model_directory_without_gguf_is_not_loadable() {
        // Metadata left behind without the weights: nothing can be loaded from
        // it, so it must not light up the AI affordances.
        let models = tempfile::tempdir().unwrap();
        write_model(models.path(), "broken-model", false);
        let (service, _cfg) = service_with_models(models.path().to_path_buf());

        assert!(!service.has_loadable_local_model().await);
    }

    #[tokio::test]
    async fn test_downloaded_local_model_does_not_cover_a_different_chosen_provider() {
        let _policy = no_policy();
        // A local model is downloaded, but the user picked a cloud provider that
        // is not reachable. A request would fail rather than quietly run on the
        // local model, so availability must report false — otherwise the AI
        // affordances light up and every click errors.
        let models = tempfile::tempdir().unwrap();
        write_model(models.path(), "ready-model", true);
        let (mut service, _cfg) = service_with_models(models.path().to_path_buf());
        service.config.active_provider = Some(AiProviderType::Anthropic);

        assert!(service.has_loadable_local_model().await);
        assert!(!service.has_available_provider().await);
        let reason = service.unavailable_reason().await.expect("unavailable");
        assert!(reason.contains("Anthropic Claude"), "{reason}");
    }

    #[tokio::test]
    async fn test_downloaded_local_model_covers_local_inference_when_chosen() {
        let _policy = no_policy();
        let models = tempfile::tempdir().unwrap();
        write_model(models.path(), "ready-model", true);
        let (mut service, _cfg) = service_with_models(models.path().to_path_buf());
        service.config.active_provider = Some(AiProviderType::LocalInference);

        assert!(service.has_available_provider().await);
        assert!(service.unavailable_reason().await.is_none());
    }

    #[tokio::test]
    async fn test_unavailable_reason_is_generic_when_nothing_is_configured() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let service = test_service(&dir);
        assert!(service.config.active_provider.is_none());

        let reason = service.unavailable_reason().await.expect("unavailable");
        assert!(reason.contains("No AI provider available"), "{reason}");
    }

    #[tokio::test]
    async fn test_unavailable_reason_is_none_for_the_chosen_provider() {
        let _policy = no_policy();
        let dir = tempfile::tempdir().unwrap();
        let mut service = test_service(&dir);
        set_key(&mut service, AiProviderType::Anthropic, "test-key");
        service.config.active_provider = Some(AiProviderType::Anthropic);

        assert!(service.unavailable_reason().await.is_none());
        assert!(service.has_available_provider().await);
    }

    #[tokio::test]
    async fn test_ensure_local_model_loaded_skips_a_model_with_no_gguf() {
        let models = tempfile::tempdir().unwrap();
        write_model(models.path(), "broken-model", false);
        let (service, _cfg) = service_with_models(models.path().to_path_buf());

        // Attempting to load the missing GGUF would fail and leave the provider
        // parked in `Error`; it must be skipped instead.
        assert!(service.ensure_local_model_loaded().await.is_ok());
        assert_eq!(
            service.get_local_model_status().await,
            providers::LocalModelStatus::Unloaded
        );
    }

    // --- Prompt language selection ------------------------------------------
    //
    // The prompt constants above are the English behaviour that predates the
    // language setting; the selectors must keep returning exactly those for
    // `En` so an older frontend (or a persisted payload without the field)
    // behaves as it always did, and must return a genuinely Chinese prompt —
    // instructions in Chinese AND an explicit Simplified-Chinese output rule —
    // for `Zh`, with the JSON keys the parsers read left in English.

    fn contains_cjk(text: &str) -> bool {
        text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    }

    fn assert_zh_prompt(name: &str, prompt: &str) {
        assert!(!prompt.trim().is_empty(), "{name}: prompt is empty");
        assert!(
            contains_cjk(prompt),
            "{name}: Chinese prompt must contain CJK instructions"
        );
        assert!(
            prompt.contains("简体中文"),
            "{name}: must explicitly require Simplified Chinese output"
        );
    }

    #[test]
    fn test_prompt_language_default_is_english() {
        assert_eq!(PromptLanguage::default(), PromptLanguage::En);
        assert!(!PromptLanguage::En.is_zh());
        assert!(PromptLanguage::Zh.is_zh());
    }

    #[test]
    fn test_prompt_language_wire_format_is_snake_case() {
        // These exact strings are the IPC wire format the TypeScript
        // `PromptLanguage` union sends and the settings store persists.
        assert_eq!(
            serde_json::to_string(&PromptLanguage::En).unwrap(),
            "\"en\""
        );
        assert_eq!(
            serde_json::to_string(&PromptLanguage::Zh).unwrap(),
            "\"zh\""
        );
        assert_eq!(
            serde_json::from_str::<PromptLanguage>("\"zh\"").unwrap(),
            PromptLanguage::Zh
        );
        assert_eq!(
            serde_json::from_str::<PromptLanguage>("\"en\"").unwrap(),
            PromptLanguage::En
        );
    }

    /// The English selector must be a drop-in for the old constant, because a
    /// frontend that has not been updated sends no `promptLanguage` at all.
    #[test]
    fn test_english_prompt_selectors_return_the_existing_constants() {
        assert_eq!(
            commit_message_prompt(PromptLanguage::En),
            COMMIT_MESSAGE_PROMPT
        );
        assert_eq!(vibe_check_prompt(PromptLanguage::En), VIBE_CHECK_PROMPT);
        assert_eq!(commit_split_prompt(PromptLanguage::En), COMMIT_SPLIT_PROMPT);
        assert_eq!(changelog_prompt(PromptLanguage::En), CHANGELOG_PROMPT);
        assert_eq!(
            pr_description_prompt(PromptLanguage::En),
            PR_DESCRIPTION_PROMPT
        );
        assert_eq!(
            conflict_resolution_prompt(PromptLanguage::En),
            CONFLICT_RESOLUTION_PROMPT
        );
        assert_eq!(
            conflict_explain_prompt(PromptLanguage::En),
            CONFLICT_EXPLAIN_PROMPT
        );
        assert_eq!(reflog_match_prompt(PromptLanguage::En), REFLOG_MATCH_PROMPT);
    }

    #[test]
    fn test_every_prompt_selector_returns_non_empty_text() {
        for language in [PromptLanguage::En, PromptLanguage::Zh] {
            let prompts: [(&str, &str); 8] = [
                ("commit_message_prompt", commit_message_prompt(language)),
                ("vibe_check_prompt", vibe_check_prompt(language)),
                ("commit_split_prompt", commit_split_prompt(language)),
                ("changelog_prompt", changelog_prompt(language)),
                ("pr_description_prompt", pr_description_prompt(language)),
                (
                    "conflict_resolution_prompt",
                    conflict_resolution_prompt(language),
                ),
                ("conflict_explain_prompt", conflict_explain_prompt(language)),
                ("reflog_match_prompt", reflog_match_prompt(language)),
            ];
            for (name, prompt) in prompts {
                assert!(
                    !prompt.trim().is_empty(),
                    "{name}: empty prompt for {language:?}"
                );
            }
        }
    }

    #[test]
    fn test_chinese_prompt_selectors_require_simplified_chinese_output() {
        let prompts: [(&str, &str); 8] = [
            (
                "commit_message_prompt",
                commit_message_prompt(PromptLanguage::Zh),
            ),
            ("vibe_check_prompt", vibe_check_prompt(PromptLanguage::Zh)),
            (
                "commit_split_prompt",
                commit_split_prompt(PromptLanguage::Zh),
            ),
            ("changelog_prompt", changelog_prompt(PromptLanguage::Zh)),
            (
                "pr_description_prompt",
                pr_description_prompt(PromptLanguage::Zh),
            ),
            (
                "conflict_resolution_prompt",
                conflict_resolution_prompt(PromptLanguage::Zh),
            ),
            (
                "conflict_explain_prompt",
                conflict_explain_prompt(PromptLanguage::Zh),
            ),
            (
                "reflog_match_prompt",
                reflog_match_prompt(PromptLanguage::Zh),
            ),
        ];
        for (name, prompt) in prompts {
            assert_zh_prompt(name, prompt);
        }
    }

    /// The Chinese prompts are still fed to parsers/key substitution, so the
    /// placeholders and JSON keys must survive translation.
    #[test]
    fn test_chinese_prompts_keep_placeholders_and_json_keys() {
        assert!(pr_description_prompt(PromptLanguage::En).contains("{title}"));
        assert!(pr_description_prompt(PromptLanguage::Zh).contains("{title}"));
        assert!(reflog_match_prompt(PromptLanguage::En).contains("{query}"));
        assert!(reflog_match_prompt(PromptLanguage::Zh).contains("{query}"));

        let vibe = vibe_check_prompt(PromptLanguage::Zh);
        for key in ["findings", "category", "severity", "message", "filePath"] {
            assert!(
                vibe.contains(&format!("\"{key}\"")),
                "vibe check zh prompt lost JSON key {key}"
            );
        }
        assert!(vibe.contains("riskLevel"));

        let split = commit_split_prompt(PromptLanguage::Zh);
        for key in [
            "shouldSplit",
            "groups",
            "label",
            "files",
            "suggestedMessage",
        ] {
            assert!(
                split.contains(&format!("\"{key}\"")),
                "commit split zh prompt lost JSON key {key}"
            );
        }

        let resolution = conflict_resolution_prompt(PromptLanguage::Zh);
        assert!(resolution.contains("resolvedContent"));
        assert!(resolution.contains("explanation"));

        let explain = conflict_explain_prompt(PromptLanguage::Zh);
        assert!(explain.contains("oursSummary"));
        assert!(explain.contains("theirsSummary"));

        let reflog = reflog_match_prompt(PromptLanguage::Zh);
        assert!(reflog.contains("\"index\""));
        assert!(reflog.contains("\"description\""));
    }

    /// Providers concatenate the raw diff after the prompt, so the trailing
    /// "Diff:"-style tail must be preserved in both languages.
    #[test]
    fn test_prompt_tails_are_kept_for_diff_concatenation() {
        for language in [PromptLanguage::En, PromptLanguage::Zh] {
            assert!(commit_message_prompt(language)
                .trim_end()
                .ends_with("Diff:"));
            assert!(vibe_check_prompt(language).trim_end().ends_with("Diff:"));
            assert!(commit_split_prompt(language).trim_end().ends_with("Diff:"));
        }
        // Human-facing tails are language specific.
        assert!(changelog_prompt(PromptLanguage::En)
            .trim_end()
            .ends_with("Commits:"));
        assert!(changelog_prompt(PromptLanguage::Zh)
            .trim_end()
            .ends_with("提交记录："));
        assert!(pr_description_prompt(PromptLanguage::En)
            .trim_end()
            .ends_with("Commits and stats:"));
        assert!(pr_description_prompt(PromptLanguage::Zh)
            .trim_end()
            .ends_with("提交记录和统计："));
        assert!(reflog_match_prompt(PromptLanguage::En)
            .trim_end()
            .ends_with("Reflog:"));
        assert!(reflog_match_prompt(PromptLanguage::Zh)
            .trim_end()
            .ends_with("Reflog:"));
    }
}
