//! Application menu command handlers
//!
//! The menu's structure is static (see `crate::menu`); its enabled state and
//! the accelerator shown on each item are not. Both depend on state only the
//! frontend has — whether a repository is open, and what the user has rebound
//! their keyboard shortcuts to — so the frontend pushes them here.

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use crate::error::{GitnadoError, Result};
use crate::menu::{apply_app_menu_labels, AppMenuState, MenuItemUpdate};

/// Update the enabled state and accelerator of application menu items.
#[tauri::command]
pub fn sync_app_menu(app: AppHandle, items: Vec<MenuItemUpdate>) -> Result<()> {
    // `try_state` rather than `state`: the menu is not installed when the menu
    // build failed at startup (or on a platform without one), and a missing
    // state must be a plain error the frontend can log, not a panic that takes
    // the whole command bridge down.
    let state = app
        .try_state::<AppMenuState>()
        .ok_or_else(|| GitnadoError::OperationFailed("application menu is not available".into()))?;

    state.apply(&items)
}

/// Retitle the application menu for a newly selected language.
///
/// The frontend sends every section and item id it can name (see
/// `localizedMenuLabels()` in `src/services/app-menu.service.ts`); ids it omits
/// keep the English label, so a partial map degrades to English rows rather
/// than an empty menu.
#[tauri::command]
pub fn set_app_menu_labels(app: AppHandle, labels: HashMap<String, String>) -> Result<()> {
    apply_app_menu_labels(&app, &labels)
}

#[cfg(test)]
mod tests {
    use crate::menu::{AppMenuState, MenuItemUpdate};

    #[test]
    fn applying_an_update_for_a_missing_item_is_reported() {
        let state = AppMenuState::default();
        let result = state.apply(&[MenuItemUpdate {
            id: "no-such-item".into(),
            enabled: false,
            accelerator: None,
        }]);
        assert!(result.is_err());
    }
}
