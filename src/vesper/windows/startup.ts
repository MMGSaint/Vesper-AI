export interface StartupPreference {
  enabled: boolean;
  applied: boolean;
  detail: string;
}

export function describeStartupRegistration(input: {
  enabled: boolean;
  platform?: NodeJS.Platform;
}): StartupPreference {
  const platform = input.platform ?? process.platform;
  if (!input.enabled) {
    return {
      enabled: false,
      applied: false,
      detail: "Start on login is off. No OS startup entry was written.",
    };
  }
  if (platform !== "win32") {
    return {
      enabled: true,
      applied: false,
      detail:
        "Start on login is preferred, but this host is not Windows. The HKCU Run key was not written.",
    };
  }
  return {
    enabled: true,
    applied: false,
    detail:
      "Start on login is preferred. Writing HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run is hardware-dependent and was not applied from this environment.",
  };
}
