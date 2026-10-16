//! Trusted executable only. Core retains forbid(unsafe_code).
use paperclip_runner_core::factory_child_fds::ChildFdLayout;
use std::io;
#[cfg(test)]
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::process::Command;
unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn dup2(source: i32, target: i32) -> i32;
}
fn checked(value: i32) -> io::Result<i32> {
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}
#[cfg(test)]
pub fn fd_flags(fd: RawFd) -> io::Result<i32> {
    checked(unsafe { fcntl(fd, 1) })
}
pub fn install_mapper(command: &mut Command, layout: ChildFdLayout) -> io::Result<()> {
    install_inner(command, layout, false)
}
#[cfg(test)]
pub fn install_partial_failure_mapper(
    command: &mut Command,
    layout: ChildFdLayout,
) -> io::Result<()> {
    install_inner(command, layout, true)
}
fn install_inner(command: &mut Command, layout: ChildFdLayout, failure: bool) -> io::Result<()> {
    // Source ownership is captured before fork. Only bounded syscall work is
    // performed in the child; no allocation, formatting, env, locks or drops.
    unsafe {
        command.pre_exec(move || {
            checked(dup2(layout.metadata_source(), 3))?;
            if failure {
                return Err(io::Error::from_raw_os_error(5));
            }
            checked(dup2(layout.access_source(), 4))?;
            for fd in layout.artifact_sources() {
                let flags = checked(fcntl(fd, 1))?;
                checked(fcntl(fd, 2, flags & !1))?;
            }
            // Extra grant sources stay CLOEXEC; never raw-close a retained OwnedFd.
            Ok(())
        });
    }
    Ok(())
}
