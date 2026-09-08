import { useCallback, useEffect, useRef, useState } from 'react';
import type { GifPanelLibrary, GifPanelSettings, GifPanelSettingsPatch } from '../../../shared/gif-panel';
import { Icon } from '../Icon';
import { extractErrorMessage } from '../../utils/errors';
import { GifPanelViewer, type LoadedGifImage } from './GifPanelViewer';
import { GifPanelOptions } from './GifPanelOptions';
import './gif-panel.css';

interface GifPanelProps {
  settings: GifPanelSettings;
  onSettingsChange: (settings: GifPanelSettings) => void;
}

const EMPTY_LIBRARY: GifPanelLibrary = { images: [], warnings: [] };
const CURRENT_IMAGE_KEY = 'tether.gifPanel.currentImage';

function lastImage(): string {
  try { return localStorage.getItem(CURRENT_IMAGE_KEY) || ''; } catch { return ''; }
}

export function GifPanel({ settings, onSettingsChange }: Readonly<GifPanelProps>) {
  const [library, setLibrary] = useState(EMPTY_LIBRARY);
  const [selectedId, setSelectedId] = useState(lastImage);
  const [image, setImage] = useState<LoadedGifImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutationPending = useRef(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(!document.hidden);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const active = settings.enabled && !settings.collapsed && visible;
  const sourceKey = JSON.stringify(settings.sources);
  const current = library.images.find(item => item.id === selectedId) ?? library.images[0];
  const currentIndex = current ? library.images.indexOf(current) : -1;
  const imageKey = current ? `${current.id}:${current.version}` : '';
  const motionPaused = reducedMotion && !motionAllowed;

  useEffect(() => {
    const changeVisibility = () => setVisible(!document.hidden);
    const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const changeMotion = () => {
      setReducedMotion(preference?.matches ?? false);
      setMotionAllowed(false);
    };
    document.addEventListener('visibilitychange', changeVisibility);
    preference?.addEventListener('change', changeMotion);
    return () => {
      document.removeEventListener('visibilitychange', changeVisibility);
      preference?.removeEventListener('change', changeMotion);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let pending = false;
    setLibrary(EMPTY_LIBRARY);
    const load = async () => {
      if (pending) return;
      pending = true;
      setScanning(true);
      try {
        const result = await globalThis.electronAPI.gifPanel.getLibrary();
        if (!cancelled) {
          setLibrary(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(extractErrorMessage(err));
      } finally {
        pending = false;
        if (!cancelled) setScanning(false);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, sourceKey, settings.recursive, refresh]);

  useEffect(() => {
    if (!active || !current || motionPaused) {
      setImage(null);
      return;
    }
    let cancelled = false;
    setImage(null);
    globalThis.electronAPI.gifPanel.readImage(current.id).then(url => {
      if (!cancelled) setImage({ key: imageKey, url });
    }).catch(err => {
      if (!cancelled) setImage({ key: imageKey, error: extractErrorMessage(err) });
    });
    return () => { cancelled = true; };
  }, [active, current?.id, imageKey, motionPaused]);

  useEffect(() => {
    if (current) {
      try { localStorage.setItem(CURRENT_IMAGE_KEY, current.id); } catch { /* Storage may be unavailable. */ }
    }
  }, [current?.id]);

  const navigate = useCallback((direction: 'next' | 'previous' | 'shuffle') => {
    const count = library.images.length;
    if (count < 2) return;
    // Shuffle always selects a different image.
    let step = 1;
    if (direction === 'previous') step = -1;
    if (direction === 'shuffle') {
      const fraction = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
      step = 1 + Math.floor(fraction * (count - 1));
    }
    setSelectedId(library.images[(currentIndex + step + count) % count].id);
  }, [library.images, currentIndex]);

  useEffect(() => {
    if (!active || motionPaused || !settings.rotationEnabled || library.images.length < 2) return;
    const timer = setInterval(() => navigate('shuffle'), settings.intervalMs);
    return () => clearInterval(timer);
  }, [active, motionPaused, settings.rotationEnabled, settings.intervalMs, library.images.length, navigate]);

  const mutate = async (operation: () => Promise<GifPanelSettings>) => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    try { onSettingsChange(await operation()); }
    catch (err) { setError(extractErrorMessage(err)); }
    finally { mutationPending.current = false; setBusy(false); }
  };
  const update = (patch: GifPanelSettingsPatch) => { void mutate(() => globalThis.electronAPI.gifPanel.updateSettings(patch)); };
  const addFolders = () => { void mutate(() => globalThis.electronAPI.gifPanel.addSources()); };
  const currentImage = image?.key === imageKey ? image : null;

  return (
    <section className="gif-panel" aria-label="GIF panel">
      <div className="gif-panel-header">
        <button className="gif-panel-heading" aria-expanded={!settings.collapsed} aria-controls="gif-panel-content" disabled={busy} onClick={() => update({ collapsed: !settings.collapsed })}>
          <Icon name="chevron" size={12} style={{ transform: settings.collapsed ? undefined : 'rotate(90deg)' }} />
          GIF Panel
        </button>
        <button className="icon-button" aria-label="Hide GIF panel" title="Hide GIF panel (View menu to reopen)" disabled={busy} onClick={() => update({ enabled: false })}><Icon name="close" size={13} /></button>
      </div>
      {error && <p className="gif-panel-error" role="alert">{error}</p>}
      {!settings.collapsed && (
        <div id="gif-panel-content" className="gif-panel-content">
          <GifPanelViewer
            active={active}
            current={current}
            image={currentImage}
            scaleMode={settings.scaleMode}
            motionPaused={motionPaused}
            scanning={scanning}
            hasSources={settings.sources.length > 0}
            busy={busy}
            onPlay={() => setMotionAllowed(true)}
            onAddFolders={addFolders}
            onImageError={() => setImage({ key: imageKey, error: 'This image could not be displayed. Try Next or Rescan.' })}
          />
          {current && <div className="gif-panel-caption"><span title={current.name}>{current.name}</span><span>{currentIndex + 1}/{library.images.length}</span></div>}
          <div className="gif-panel-controls" aria-label="GIF playback controls">
            <button className="gif-panel-button" aria-label="Previous GIF" title="Previous GIF" disabled={library.images.length < 2} onClick={() => navigate('previous')}>‹</button>
            <button className="gif-panel-button" aria-label="Shuffle GIF" title="Shuffle GIF" disabled={library.images.length < 2} onClick={() => navigate('shuffle')}>Shuffle</button>
            <button className="gif-panel-button" aria-label="Next GIF" title="Next GIF" disabled={library.images.length < 2} onClick={() => navigate('next')}>›</button>
            <button className="gif-panel-button gif-panel-rotate" aria-label="Auto-rotate GIFs" aria-pressed={settings.rotationEnabled} title="Auto-rotate GIFs" disabled={busy || motionPaused} onClick={() => update({ rotationEnabled: !settings.rotationEnabled })}>{settings.rotationEnabled ? 'Pause' : 'Rotate'}</button>
          </div>
          <div className="gif-panel-tools">
            <button className="gif-panel-button" aria-expanded={manageOpen} aria-controls="gif-panel-options" onClick={() => setManageOpen(value => !value)}>Folders & options</button>
            <button className="gif-panel-button" disabled={scanning || busy} onClick={() => setRefresh(value => value + 1)}>Rescan</button>
          </div>
          {manageOpen && (
            <GifPanelOptions
              settings={settings}
              busy={busy}
              showStopAnimations={reducedMotion && motionAllowed}
              onAddFolders={addFolders}
              onRemoveFolder={source => { void mutate(() => globalThis.electronAPI.gifPanel.removeSource(source)); }}
              onUpdate={update}
              onStopAnimations={() => setMotionAllowed(false)}
            />
          )}
          {library.warnings.map(warning => <p className="gif-panel-note" key={warning}>{warning}</p>)}
        </div>
      )}
    </section>
  );
}
