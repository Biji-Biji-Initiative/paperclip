//! Exclusive descriptor ownership and one-time trusted mapper installation.
use std::collections::BTreeSet;
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, AsRawFd, OwnedFd, RawFd};
use std::process::{Child, Command};
use std::sync::OnceLock;

pub fn duplicate_cloexec_above_fixed_slots(fd: &impl AsFd) -> io::Result<OwnedFd> {
    rustix::io::fcntl_dupfd_cloexec(fd, 5).map_err(io::Error::from)
}
pub struct FixedSlotGuards {
    metadata: File,
    access: File,
}
impl FixedSlotGuards {
    /// Earliest single-threaded startup only; no unknown descriptor is adopted.
    pub fn acquire_at_single_threaded_startup() -> io::Result<Self> {
        if std::fs::read_dir("/proc/self/task")?.count() != 1 {
            return Err(io::Error::from_raw_os_error(16));
        }
        let metadata = File::open("/dev/null")?;
        if metadata.as_raw_fd() != 3 {
            return Err(io::Error::from_raw_os_error(16));
        }
        let access = File::open("/dev/null")?;
        if access.as_raw_fd() != 4 {
            return Err(io::Error::from_raw_os_error(16));
        }
        let guards = Self { metadata, access };
        guards.validate()?;
        Ok(guards)
    }
    fn validate(&self) -> io::Result<()> {
        if self.metadata.as_raw_fd() != 3
            || self.access.as_raw_fd() != 4
            || !rustix::io::fcntl_getfd(&self.metadata)?.contains(rustix::io::FdFlags::CLOEXEC)
            || !rustix::io::fcntl_getfd(&self.access)?.contains(rustix::io::FdFlags::CLOEXEC)
        {
            return Err(io::Error::from_raw_os_error(22));
        }
        Ok(())
    }
}
pub struct ChildFdLayout {
    metadata: OwnedFd,
    access: OwnedFd,
    artifacts: Vec<OwnedFd>,
}
impl ChildFdLayout {
    pub fn new(metadata: OwnedFd, access: OwnedFd, artifacts: Vec<OwnedFd>) -> io::Result<Self> {
        let layout = Self {
            metadata,
            access,
            artifacts,
        };
        let mut seen = BTreeSet::new();
        for fd in [&layout.metadata, &layout.access]
            .into_iter()
            .chain(layout.artifacts.iter())
        {
            if fd.as_raw_fd() < 5
                || !seen.insert(fd.as_raw_fd())
                || !rustix::io::fcntl_getfd(fd)?.contains(rustix::io::FdFlags::CLOEXEC)
            {
                return Err(io::Error::from_raw_os_error(22));
            }
        }
        Ok(layout)
    }
    // Accessors expose descriptor numbers only to the trusted binary callback.
    pub fn metadata_source(&self) -> RawFd {
        self.metadata.as_raw_fd()
    }
    pub fn access_source(&self) -> RawFd {
        self.access.as_raw_fd()
    }
    pub fn artifact_sources(&self) -> impl Iterator<Item = RawFd> + '_ {
        self.artifacts.iter().map(AsRawFd::as_raw_fd)
    }
}
pub type ChildFdMapper = fn(&mut Command, ChildFdLayout) -> io::Result<()>;
struct InstalledMapper {
    guards: FixedSlotGuards,
    mapper: ChildFdMapper,
}
static MAPPER: OnceLock<InstalledMapper> = OnceLock::new();
pub fn install_factory_child_fd_mapper(
    guards: FixedSlotGuards,
    mapper: ChildFdMapper,
) -> io::Result<()> {
    guards.validate()?;
    MAPPER
        .set(InstalledMapper { guards, mapper })
        .map_err(|_| io::Error::from_raw_os_error(114))
}
/// Consumes Command and layout in the parent; the caller cannot reuse either.
pub fn spawn_factory_child_once(command: Command, layout: ChildFdLayout) -> io::Result<Child> {
    let installed = MAPPER
        .get()
        .ok_or_else(|| io::Error::from_raw_os_error(1))?;
    PreparedLaunch::new(command, layout, &installed.guards, installed.mapper).spawn_once()
}
pub struct PreparedLaunch<'a> {
    command: Option<Command>,
    layout: Option<ChildFdLayout>,
    guards: &'a FixedSlotGuards,
    mapper: ChildFdMapper,
}
impl<'a> PreparedLaunch<'a> {
    pub fn new(
        command: Command,
        layout: ChildFdLayout,
        guards: &'a FixedSlotGuards,
        mapper: ChildFdMapper,
    ) -> Self {
        Self {
            command: Some(command),
            layout: Some(layout),
            guards,
            mapper,
        }
    }
    pub fn spawn_once(&mut self) -> io::Result<Child> {
        let mut command = self
            .command
            .take()
            .ok_or_else(|| io::Error::from_raw_os_error(114))?;
        let layout = self
            .layout
            .take()
            .ok_or_else(|| io::Error::from_raw_os_error(114))?;
        self.guards.validate()?;
        (self.mapper)(&mut command, layout)?;
        command.spawn()
    }
}
