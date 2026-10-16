//! The only raw-FD ownership conversion. This lives in the executable crate;
//! runner-core retains `#![forbid(unsafe_code)]`.
//!
//! Parent contract: an otherwise unaliased inherited anonymous read pipe at the
//! selected fd >= 3 is transferred exclusively to runnerd. No other Rust object
//! may own it. This is not an arbitrary descriptor lookup API for agent input.
use paperclip_runner_core::codex_external_auth::{ExternalAuthHold, HoldReason, INGRESS_FD_ENV};
use std::fs::File;
use std::sync::atomic::{AtomicBool, Ordering};
static TAKEN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
pub fn take_selected() -> Result<Option<File>, ExternalAuthHold> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    let Some(raw) = std::env::var_os(INGRESS_FD_ENV) else {
        return Ok(None);
    };
    if TAKEN.swap(true, Ordering::AcqRel) {
        return Err(ExternalAuthHold(HoldReason::SourceAlreadyConsumed));
    }
    let value = raw
        .to_str()
        .ok_or(ExternalAuthHold(HoldReason::UnsafeSource))?;
    if value.is_empty() || value.len() > 4 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ExternalAuthHold(HoldReason::UnsafeSource));
    }
    let fd = value
        .parse::<i32>()
        .map_err(|_| ExternalAuthHold(HoldReason::UnsafeSource))?;
    if !(3..=1024).contains(&fd) {
        return Err(ExternalAuthHold(HoldReason::UnsafeSource));
    }
    // F_GETFD performs no ownership conversion, and returns EBADF for a closed
    // descriptor. Set close-on-exec before constructing any child or thread.
    let flags = unsafe { fcntl(fd, 1) };
    if flags < 0 {
        return Err(ExternalAuthHold(HoldReason::MissingSource));
    }
    if unsafe { fcntl(fd, 2, flags | 1) } < 0 {
        return Err(ExternalAuthHold(HoldReason::UnsafeSource));
    }
    // SAFETY: fd was checked open above. The executable is single-threaded at
    // this point and owns the exclusive transfer described by the parent
    // contract. Conversion is reached once; File closes on every later path.
    Ok(Some(unsafe { File::from_raw_fd(fd) }))
}
#[cfg(not(target_os = "linux"))]
pub fn take_selected() -> Result<Option<File>, ExternalAuthHold> {
    if std::env::var_os(INGRESS_FD_ENV).is_some() {
        Err(ExternalAuthHold(HoldReason::UnsafeSource))
    } else {
        Ok(None)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
    use std::process::Command;
    fn run_case(name: &str) {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "external_auth_fd::tests::child", "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("FACTORY_FD_FIXTURE", name)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fd fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn absent_source_is_noop() {
        run_case("absent");
    }
    #[test]
    fn invalid_descriptor_is_rejected() {
        run_case("invalid");
    }
    #[test]
    fn closed_descriptor_is_rejected() {
        run_case("closed");
    }
    #[test]
    fn ownership_can_only_be_taken_once() {
        run_case("duplicate");
    }
    #[test]
    fn descriptor_is_cloexec_before_child_spawn() {
        run_case("cloexec");
    }
    #[test]
    fn child() {
        let Ok(case) = std::env::var("FACTORY_FD_FIXTURE") else {
            return;
        };
        if case == "absent" {
            assert!(take_selected().unwrap().is_none());
            return;
        }
        if case == "invalid" {
            std::env::set_var(INGRESS_FD_ENV, "0");
            assert!(matches!(
                take_selected(),
                Err(ExternalAuthHold(HoldReason::UnsafeSource))
            ));
            return;
        }
        let (read, write) = std::io::pipe().unwrap();
        let raw = read.into_raw_fd();
        std::env::set_var(INGRESS_FD_ENV, raw.to_string());
        if case == "closed" {
            // SAFETY: this test owns the raw descriptor transferred just above.
            drop(unsafe { File::from_raw_fd(raw) });
            assert!(matches!(
                take_selected(),
                Err(ExternalAuthHold(HoldReason::MissingSource))
            ));
        } else {
            let owned = take_selected().unwrap().unwrap();
            assert_eq!(owned.as_raw_fd(), raw);
            assert!(rustix::io::fcntl_getfd(&owned)
                .unwrap()
                .contains(rustix::io::FdFlags::CLOEXEC));
            if case == "duplicate" {
                assert!(matches!(
                    take_selected(),
                    Err(ExternalAuthHold(HoldReason::SourceAlreadyConsumed))
                ));
            } else {
                assert_eq!(case, "cloexec");
                let code =
                    "import os,sys; p='/proc/self/fd/'+sys.argv[1]; assert not os.path.exists(p)";
                assert!(Command::new("/usr/bin/python3")
                    .args(["-c", code, &raw.to_string()])
                    .env_clear()
                    .status()
                    .unwrap()
                    .success());
            }
            drop(owned);
        }
        drop(write);
    }
}
