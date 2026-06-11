pub mod disk;
pub mod embed;
pub mod multiroot;
pub mod readonly;
pub use disk::DiskSpacePrimitives;
pub use embed::EmbeddedReadOnlySpacePrimitives;
pub use multiroot::{MultiRootSpacePrimitives, RootConfig};
pub use readonly::ReadOnlySpacePrimitives;
