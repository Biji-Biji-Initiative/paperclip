//! Binary-only ownership boundary; call before spawning threads/children.
use paperclip_runner_core::claude_external_auth::{ClaudeHold, Reason, INGRESS_FD_ENV};
use std::fs::File;
use std::os::unix::fs::FileTypeExt;
use std::sync::atomic::{AtomicBool, Ordering};
static TAKEN: AtomicBool = AtomicBool::new(false);
unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

pub fn take_selected() -> Result<Option<File>, ClaudeHold> {
    use std::os::fd::FromRawFd;
    let claude = std::env::var_os(INGRESS_FD_ENV);
    paperclip_runner_core::claude_external_auth::validate_mutual_exclusion(
        std::env::var_os("PAPERCLIP_CODEX_EXTERNAL_AUTH_FD").is_some(),
        claude.is_some(),
    )?;
    let Some(value) = claude else {
        return Ok(None);
    };
    if TAKEN.swap(true, Ordering::AcqRel) {
        return Err(ClaudeHold(Reason::Consumed));
    }
    let text = value.to_str().ok_or(ClaudeHold(Reason::Source))?;
    if text.is_empty() || text.len() > 4 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ClaudeHold(Reason::Source));
    }
    let fd: i32 = text.parse().map_err(|_| ClaudeHold(Reason::Source))?;
    if !(3..=1024).contains(&fd) {
        return Err(ClaudeHold(Reason::Source));
    }
    let path = format!("/proc/self/fd/{fd}");
    if !std::fs::read_link(&path)
        .map_err(|_| ClaudeHold(Reason::Source))?
        .to_string_lossy()
        .starts_with("pipe:[")
        || !std::fs::metadata(path)
            .map_err(|_| ClaudeHold(Reason::Source))?
            .file_type()
            .is_fifo()
    {
        return Err(ClaudeHold(Reason::Source));
    }
    // The trusted parent exclusively transfers this open anonymous pipe. No
    // other Rust owner exists, and this intake runs once before any threads.
    let flags = unsafe { fcntl(fd, 1) };
    if flags < 0 || unsafe { fcntl(fd, 2, flags | 1) } < 0 {
        return Err(ClaudeHold(Reason::Source));
    }
    Ok(Some(unsafe { File::from_raw_fd(fd) }))
}
