import { hideMissingImage } from './inara-images.js';

/**
 * A rank, navy or Powerplay insignia: the game's artwork, downloaded from Inara into the data folder
 * the first time EDJT runs (src/assets/inara-assets.mjs). Nothing is shown when there's no image
 * for it (the Alliance and Independents have none), or when it hasn't been downloaded.
 * @param {{ imageUrl?: string | null, size?: number, title?: string, className?: string }} props
 */
export default function RankIcon({ imageUrl, size = 40, title, className }) {
  if (!imageUrl) return null;
  return (
    <img
      className={className ? `rank-image ${className}` : 'rank-image'}
      src={imageUrl}
      width={size}
      height={size}
      alt={title ?? ''}
      title={title}
      onError={hideMissingImage}
    />
  );
}
