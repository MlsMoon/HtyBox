//! Cross-platform operation interface and target-specific service selection.

mod base;
mod common;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(unix, not(target_os = "macos")))]
mod unix;
#[cfg(windows)]
mod windows;

pub use base::{PlatformCapabilities, PlatformServices};

#[cfg(windows)]
static PLATFORM_SERVICES: windows::WindowsPlatformServices = windows::WindowsPlatformServices;
#[cfg(target_os = "macos")]
static PLATFORM_SERVICES: macos::MacosPlatformServices = macos::MacosPlatformServices;
#[cfg(all(unix, not(target_os = "macos")))]
static PLATFORM_SERVICES: unix::UnixPlatformServices = unix::UnixPlatformServices;

pub fn platform_services() -> &'static dyn PlatformServices {
    &PLATFORM_SERVICES
}
