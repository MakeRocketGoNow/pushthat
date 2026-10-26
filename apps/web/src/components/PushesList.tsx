// cspell:ignore pproj indd flac
import clsx from 'clsx';
import { Dispatch, SetStateAction, useState } from 'react';

import { CheckIcon } from '@/components/icons/CheckIcon';
import { Push } from '@/types/pushes';

import styles from './PushesList.module.css';

interface PushesListProps {
  pushes: Push[];
  error?: string;
  loading?: boolean;
  selectedPushes: Set<string>;
  onSelectedPushesChange: Dispatch<SetStateAction<Set<string>>>;
}

const ICONS = [
  'pproj.svg',
  'zip.svg',
  'indd.svg',
  'csv.svg',
  'css.svg',
  'pdf.svg',
  'aac.svg',
  'png.svg',
  'xls.svg',
  'avi.svg',
  'txt.svg',
  'mp3.svg',
  'tiff.svg',
  'psd.svg',
  'jpg.svg',
  'jpeg.svg',
  'mov.svg',
  'html.svg',
  'ai.svg',
  'js.svg',
  'flac.svg',
  'mp4.svg',
  'gif.svg',
  'doc.svg',
  'xml.svg',
  'apk.svg',
];

export default function PushesList({
  pushes,
  error,
  loading,
  selectedPushes,
  onSelectedPushesChange,
}: PushesListProps) {
  const [lowResImages, setLowResImages] = useState<Set<string>>(new Set());

  const handleSelect = (pushId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    onSelectedPushesChange((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(pushId)) {
        newSet.delete(pushId);
      } else {
        newSet.add(pushId);
      }
      return newSet;
    });
  };

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>, pushId: string) => {
    const image = event.currentTarget;
    if (image.naturalHeight === 16) {
      setLowResImages((prev) => new Set(prev).add(pushId));
    }
  };

  const getFallbackImageSrc = (push: Push, icon: string | undefined) => {
    // If this push has a low-res image, use the PushThat logo as fallback
    if (lowResImages.has(push.id)) {
      return '/pushthat-mono.svg';
    }
    return null;
  };

  if (loading) {
    return <div className={styles.textContainer}>Loading...</div>;
  }

  if (pushes.length === 0) {
    return (
      <div className={clsx(styles.textContainer, error && styles.errorContainer)}>
        <p>{error || 'No links found'}</p>
      </div>
    );
  }

  return (
    <ul className={styles.pushesList}>
      {pushes.map((push) => {
        const icon = ICONS.find((icon) => push.ext === icon.split('.')[0]);
        const isSelected = selectedPushes.has(push.id);
        const fallbackSrc = getFallbackImageSrc(push, icon);

        return (
          <li key={push.id} className={styles.pushItem}>
            <a href={push.url} target="_blank" rel="noopener noreferrer" className={styles.pushLink}>
              <div
                className={clsx(styles.pushIcon, isSelected && styles.selected)}
                onClick={(e) => handleSelect(push.id, e)}
              >
                {isSelected ? (
                  <CheckIcon />
                ) : fallbackSrc ? (
                  <img src={fallbackSrc} alt="" className={styles.favicon} />
                ) : icon ? (
                  <img
                    src={`/files/${icon}`}
                    alt=""
                    className={styles.favicon}
                    onLoad={(e) => handleImageLoad(e, push.id)}
                  />
                ) : (
                  <img
                    src={push.favicon}
                    alt=""
                    className={styles.favicon}
                    onLoad={(e) => handleImageLoad(e, push.id)}
                  />
                )}
              </div>
              <div className={styles.pushContent}>
                <span className={styles.pushTitle}>{push.title || push.url}</span>
                <div className={styles.pushMeta}>{new Date(push.createdAt).toLocaleString()}</div>
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
