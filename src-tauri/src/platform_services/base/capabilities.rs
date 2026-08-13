use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)] // Each target constructs only its own variant.
pub enum PlatformKind {
    Macos,
    Windows,
    Unix,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub kind: PlatformKind,
    pub primary_shortcut_uses_meta: bool,
}

impl PlatformCapabilities {
    pub const fn new(kind: PlatformKind, primary_shortcut_uses_meta: bool) -> Self {
        Self {
            kind,
            primary_shortcut_uses_meta,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlatformCapabilities, PlatformKind};

    #[test]
    fn serializes_for_frontend_runtime() {
        let value = serde_json::to_value(PlatformCapabilities::new(PlatformKind::Macos, true))
            .expect("serialize capabilities");
        assert_eq!(value["kind"], "macos");
        assert_eq!(value["primaryShortcutUsesMeta"], true);
    }
}
