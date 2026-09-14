use serde::Serialize;
use std::sync::OnceLock;

const GIB: u64 = 1 << 30;
const MIN_LOCAL_MEMORY_BYTES: u64 = 8 * GIB;
const MIN_LOCAL_LOGICAL_CPUS: usize = 4;
const LARGE_MODEL_MEMORY_BYTES: u64 = 16 * GIB;
const LARGE_OFFERED_APPLE_GENERATION: u32 = 4;
const LARGE_PROMINENT_APPLE_GENERATION: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalTier {
  CloudDefault,
  Qwen,
  QwenLargeOffered,
  QwenLargeProminent,
}

#[derive(Debug)]
pub struct HardwareProfile {
  pub memory_bytes: u64,
  pub logical_cpus: usize,
  pub cpu_brand: String,
}

pub fn tier_for(profile: Option<&HardwareProfile>, os: &str, arch: &str) -> LocalTier {
  let Some(profile) = profile else { return LocalTier::Qwen };
  // Zero means unavailable, not a low-end device. Detection failure must not
  // silently turn a new installation into a cloud-first one.
  if profile.memory_bytes == 0 || profile.logical_cpus == 0 {
    return LocalTier::Qwen;
  }
  if profile.memory_bytes < MIN_LOCAL_MEMORY_BYTES || profile.logical_cpus < MIN_LOCAL_LOGICAL_CPUS {
    return LocalTier::CloudDefault;
  }
  if os == "macos" && arch == "aarch64" && profile.memory_bytes >= LARGE_MODEL_MEMORY_BYTES {
    let generation = profile.cpu_brand.trim().strip_prefix("Apple M")
      .map(|suffix| suffix.chars().take_while(char::is_ascii_digit).collect::<String>())
      .and_then(|digits| digits.parse::<u32>().ok());
    match generation {
      Some(generation) if generation >= LARGE_PROMINENT_APPLE_GENERATION => return LocalTier::QwenLargeProminent,
      Some(LARGE_OFFERED_APPLE_GENERATION) => return LocalTier::QwenLargeOffered,
      _ => {}
    }
  }
  LocalTier::Qwen
}

pub fn local_tier() -> LocalTier {
  static TIER: OnceLock<LocalTier> = OnceLock::new();
  *TIER.get_or_init(|| {
    let mut system = sysinfo::System::new();
    system.refresh_memory_specifics(sysinfo::MemoryRefreshKind::nothing().with_ram());
    system.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    let profile = HardwareProfile {
      memory_bytes: system.total_memory(),
      logical_cpus: system.cpus().len(),
      cpu_brand: system.cpus().first().map(|cpu| cpu.brand().to_owned()).unwrap_or_default(),
    };
    let tier = tier_for(Some(&profile), std::env::consts::OS, std::env::consts::ARCH);
    log::info!(
      target: "saytype_lifecycle",
      "hardware:profile memory_bytes={} logical_cpus={} local_tier={tier:?}",
      profile.memory_bytes, profile.logical_cpus,
    );
    tier
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn profile(memory_gib: u64, logical_cpus: usize, cpu_brand: &str) -> HardwareProfile {
    HardwareProfile { memory_bytes: memory_gib * GIB, logical_cpus, cpu_brand: cpu_brand.into() }
  }

  #[test]
  fn low_memory_or_core_count_defaults_to_cloud_on_every_platform() {
    for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("windows", "x86_64"), ("linux", "x86_64")] {
      for hardware in [profile(7, 8, "Apple M5"), profile(16, 3, "Apple M5")] {
        assert_eq!(tier_for(Some(&hardware), os, arch), LocalTier::CloudDefault);
      }
      assert_eq!(tier_for(Some(&profile(8, 4, "Generic CPU")), os, arch), LocalTier::Qwen);
    }
  }

  #[test]
  fn large_model_tiers_require_apple_silicon_generation_and_memory() {
    for (brand, memory, expected) in [
      ("Apple M3 Max", 64, LocalTier::Qwen),
      ("Apple M4", 16, LocalTier::QwenLargeOffered),
      ("Apple M4 Pro", 32, LocalTier::QwenLargeOffered),
      ("Apple M4 Max", 15, LocalTier::Qwen),
      ("Apple M5", 16, LocalTier::QwenLargeProminent),
      ("Apple M10 Ultra", 64, LocalTier::QwenLargeProminent),
      ("Apple M5", 8, LocalTier::Qwen),
      ("Unknown CPU", 32, LocalTier::Qwen),
      ("Apple M", 32, LocalTier::Qwen),
    ] {
      assert_eq!(tier_for(Some(&profile(memory, 8, brand)), "macos", "aarch64"), expected, "{brand} {memory}");
    }
  }

  #[test]
  fn other_platforms_keep_qwen_even_with_an_apple_brand() {
    for (os, arch) in [("macos", "x86_64"), ("windows", "aarch64"), ("windows", "x86_64"), ("linux", "aarch64")] {
      assert_eq!(tier_for(Some(&profile(32, 8, "Apple M5")), os, arch), LocalTier::Qwen);
    }
  }

  #[test]
  fn failed_or_incomplete_detection_never_defaults_to_cloud() {
    assert_eq!(tier_for(None, "windows", "x86_64"), LocalTier::Qwen);
    for hardware in [profile(0, 8, "Apple M5"), profile(32, 0, "Apple M5"), profile(0, 2, "Unknown")] {
      assert_eq!(tier_for(Some(&hardware), "macos", "aarch64"), LocalTier::Qwen);
    }
  }

  #[test]
  fn tiers_serialize_as_frontend_identifiers() {
    for (tier, name) in [
      (LocalTier::CloudDefault, "cloud-default"), (LocalTier::Qwen, "qwen"),
      (LocalTier::QwenLargeOffered, "qwen-large-offered"),
      (LocalTier::QwenLargeProminent, "qwen-large-prominent"),
    ] {
      assert_eq!(serde_json::to_value(tier).unwrap(), name);
    }
  }
}
