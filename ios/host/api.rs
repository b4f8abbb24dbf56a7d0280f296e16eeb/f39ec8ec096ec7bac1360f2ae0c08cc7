//! Native engine contract. UIKit and touch tracking live in the Swift shell.
use std::path::{Path, PathBuf};

/// Read-only application assets and separate writable sandbox roots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// The signed bundle. Runtime code must never create files here.
    pub bundle: PathBuf,
    /// Persistent saves and settings.
    pub data: PathBuf,
    /// Regenerable pipeline caches and temporary files.
    pub cache: PathBuf,
}

impl Paths {
    /// Derive app-owned roots from UIKit's bundle and process sandbox home.
    /// Requires disjoint absolute paths; no game data or credentials are copied.
    pub fn new(bundle: &Path, home: &Path) -> Result<Self, String> {
        if !bundle.is_absolute() || !home.is_absolute() {
            return Err("The app bundle and sandbox home must be absolute paths".into());
        }
        if bundle.starts_with(home) || home.starts_with(bundle) {
            return Err("The signed bundle must be separate from writable app data".into());
        }
        if bundle
            .components()
            .chain(home.components())
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("Parent traversal is not allowed in app roots".into());
        }
        Ok(Self {
            bundle: bundle.to_owned(),
            data: home.join("Library/Application Support/nx2ipa"),
            cache: home.join("Library/Caches/nx2ipa"),
        })
    }

    /// Check the bundle input and create only the app's writable directories.
    pub fn prepare(&self) -> Result<(), String> {
        if !self.bundle.join("game.json").is_file() {
            return Err("This app has no bundled game.json".into());
        }
        for path in [&self.data, &self.cache] {
            std::fs::create_dir_all(path)
                .map_err(|e| format!("Cannot create app data folder: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn writes_are_outside_signed_bundle() {
        let p = Paths::new(Path::new("/apps/game.app"), Path::new("/data/app")).unwrap();
        assert_eq!(
            p.data,
            Path::new("/data/app/Library/Application Support/nx2ipa")
        );
        assert_eq!(p.cache, Path::new("/data/app/Library/Caches/nx2ipa"));
        assert!(!p.data.starts_with(p.bundle));
    }
    #[test]
    fn rejects_relative_overlapping_and_parent_paths() {
        for (a, b) in [
            ("app", "/data"),
            ("/app", "data"),
            ("/app", "/app/data"),
            ("/data/app", "/data"),
            ("/app/../other", "/data"),
        ] {
            assert!(Paths::new(Path::new(a), Path::new(b)).is_err());
        }
    }
}

/// ABI-stable normalized finger, owned by the caller for the duration of a call.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

/// Main-thread-only session. Stop requests process shutdown, not a runtime reset.
#[cfg(target_os = "ios")]
pub trait Session {
    fn set_active(&mut self, active: bool);
    fn resize(&mut self, width: u32, height: u32);
    fn touches(&mut self, points: &[Touch]);
    /// None means full drawable. Only return an aspect if rendering aspect-fits.
    fn picture_aspect(&self) -> Option<f64> {
        None
    }
    fn stop(&mut self);
}
