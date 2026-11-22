/**
 * A rank, navy or Powerplay insignia: the game's artwork, stored in the app (public/inara). Nothing
 * is shown when there's no image for it (the Alliance and Independents have none).
 * @param {{ imageUrl?: string | null, size?: number, title?: string, className?: string }} props
 */
export default function RankIcon({ imageUrl, size = 40, title, className }) {
  if (!imageUrl) return null;
  return <img className={className ? `rank-image ${className}` : 'rank-image'} src={imageUrl} width={size} height={size} alt={title ?? ''} title={title} />;
}
