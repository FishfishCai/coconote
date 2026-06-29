// On-disk write for /.config: the atomic (tmp + rename) yaml writer. The
// serializer itself lives on FileConfig (config::FileConfig::to_yaml) so boot
// and PATCH share one code path.

use crate::config::FileConfig;
use crate::error::Result;
use std::path::Path;

pub(super) fn write_yaml_atomically(target: Option<&Path>, cfg: &FileConfig) -> Result<()> {
    // `None` = booted without a yaml (--folder mode, which bypasses config
    // resolution). Persisting a ./coconote.yaml no later boot would read just
    // litters the CWD: mutations stay in-process only.
    let Some(path) = target else {
        return Ok(());
    };
    cfg.save(path)
}
