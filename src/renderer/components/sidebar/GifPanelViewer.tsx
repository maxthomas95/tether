import type { GifPanelImage, GifPanelSettings } from '../../../shared/gif-panel';

export interface LoadedGifImage {
  key: string;
  url?: string;
  error?: string;
}

interface GifPanelViewerProps {
  active: boolean;
  current?: GifPanelImage;
  image: LoadedGifImage | null;
  scaleMode: GifPanelSettings['scaleMode'];
  motionPaused: boolean;
  scanning: boolean;
  hasSources: boolean;
  busy: boolean;
  onPlay: () => void;
  onAddFolders: () => void;
  onImageError: () => void;
}

function GifPanelPlaceholder({ motionPaused, image, current, scanning, hasSources, busy, onPlay, onAddFolders }: Readonly<GifPanelViewerProps>) {
  if (motionPaused) {
    return <><p>Animations are off for reduced motion.</p><button className="gif-panel-button" onClick={onPlay}>Play GIFs</button></>;
  }
  if (image?.error) return <p role="alert">{image.error}</p>;
  if (current) return <p>Loading image…</p>;
  if (scanning) return <p>Looking for GIFs…</p>;
  return (
    <>
      <p>{hasSources ? 'No GIF, APNG, or WebP images found.' : 'A little company while you code.'}</p>
      <button className="gif-panel-button" disabled={busy} onClick={onAddFolders}>Add GIF folder</button>
    </>
  );
}

export function GifPanelViewer(props: Readonly<GifPanelViewerProps>) {
  const { active, current, motionPaused, image, scaleMode, onImageError } = props;
  const showImage = active && current && !motionPaused && image?.url;
  return (
    <div className={`gif-panel-viewer gif-panel-viewer--${scaleMode}`}>
      {showImage ? (
        <img src={image.url} alt={current.name} onError={onImageError} />
      ) : (
        <div className="gif-panel-placeholder"><GifPanelPlaceholder {...props} /></div>
      )}
    </div>
  );
}
