import type { HubHealth } from "./ChiaroApi";
import { SETTINGS } from "./settings.mjs";
import type { SettingValue, SettingsValues } from "./settings.mjs";

export function SettingsPanel({
  buildVersion,
  health,
  onChange,
  onClose,
  topic,
  values,
}: {
  buildVersion: string;
  health: HubHealth;
  onChange: (id: string, value: SettingValue) => void;
  onClose: () => void;
  topic: string;
  values: SettingsValues;
}) {
  const [frontendVersion, buildHash = "开发构建"] = buildVersion.split("+", 2);
  const consistent = health.version === frontendVersion;

  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <section
        aria-labelledby="chiaro-settings-title"
        aria-modal="true"
        className="settings-panel"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="chiaro-settings-title">Chiaro 设置</h2>
            <p>个性化设置只保存在当前浏览器。</p>
          </div>
          <button aria-label="关闭设置" onClick={onClose} type="button">×</button>
        </header>
        <div className="settings-content">
          <section>
            <h3>通用</h3>
            {SETTINGS.map((setting) => (
              <label className="settings-row" key={setting.id}>
                <span><strong>{setting.label}</strong><small>{setting.description}</small></span>
                {setting.kind === "select" ? (
                  <select
                    aria-label={setting.label}
                    onChange={(event) => onChange(setting.id, event.target.value as "light" | "dark")}
                    value={values[setting.id]}
                  >
                    {setting.options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={setting.label}
                    max={setting.max}
                    min={setting.min}
                    onChange={(event) => onChange(setting.id, Number(event.target.value))}
                    step={setting.step}
                    type="number"
                    value={values[setting.id]}
                  />
                )}
              </label>
            ))}
          </section>
          <section>
            <h3>关于</h3>
            <dl className="settings-about">
              <div><dt>openchiaro</dt><dd>{health.version}</dd></div>
              <div><dt>构建哈希</dt><dd>{buildHash}</dd></div>
              <div><dt>host / 前端</dt><dd>{consistent ? "一致" : `不一致（${health.version} / ${frontendVersion}）`}</dd></div>
              <div><dt>project</dt><dd>{health.project}</dd></div>
              <div><dt>topic</dt><dd>{topic}</dd></div>
              <div><dt>Hub</dt><dd>{health.port} · pid {health.pid}</dd></div>
            </dl>
          </section>
        </div>
      </section>
    </div>
  );
}
