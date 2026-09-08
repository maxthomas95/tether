import type { GifPanelSettings, GifPanelSettingsPatch } from '../../../shared/gif-panel';
import { Icon } from '../Icon';

interface GifPanelOptionsProps {
  settings: GifPanelSettings;
  busy: boolean;
  showStopAnimations: boolean;
  onAddFolders: () => void;
  onRemoveFolder: (source: string) => void;
  onUpdate: (patch: GifPanelSettingsPatch) => void;
  onStopAnimations: () => void;
}

export function GifPanelOptions({ settings, busy, showStopAnimations, onAddFolders, onRemoveFolder, onUpdate, onStopAnimations }: Readonly<GifPanelOptionsProps>) {
  const intervals = [...new Set([1000, 3000, 5000, 10000, 15000, 30000, 60000, settings.intervalMs])].sort((a, b) => a - b);
  return (
    <div id="gif-panel-options" className="gif-panel-options">
      <div className="gif-panel-sources">
        {settings.sources.map(source => (
          <div className="gif-panel-source" key={source}>
            <span title={source}>{source}</span>
            <button className="icon-button" aria-label={`Remove folder ${source}`} title="Remove folder from panel" disabled={busy} onClick={() => onRemoveFolder(source)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
      <button className="gif-panel-button" disabled={busy} onClick={onAddFolders}>Add folder</button>
      <label>
        <input type="checkbox" checked={settings.recursive} disabled={busy} onChange={event => onUpdate({ recursive: event.target.checked })} />
        Include subfolders
      </label>
      <label>
        Image size
        <select aria-label="GIF image size" value={settings.scaleMode} disabled={busy} onChange={event => onUpdate({ scaleMode: event.target.value === 'original' ? 'original' : 'auto' })}>
          <option value="auto">Fit panel</option>
          <option value="original">Original</option>
        </select>
      </label>
      <label>
        Rotate every
        <select aria-label="GIF rotation interval" value={settings.intervalMs} disabled={busy} onChange={event => onUpdate({ intervalMs: Number(event.target.value) })}>
          {intervals.map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
        </select>
      </label>
      <p className="gif-panel-note">GIF, APNG, WebP · Local folders only. Changes save immediately.</p>
      {showStopAnimations && <button className="gif-panel-button" onClick={onStopAnimations}>Stop animations</button>}
    </div>
  );
}
