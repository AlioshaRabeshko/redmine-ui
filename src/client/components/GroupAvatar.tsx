import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import type { AssigneeOption, GroupAvatarOverride } from '../../shared/types';
import './GroupAvatar.css';

type GroupIdentity = Extract<AssigneeOption, { type: 'group' }>;

export function GroupAvatar({ group, override, size = 'md', label }: {
  group: GroupIdentity;
  override?: GroupAvatarOverride;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const image = override?.kind === 'photo' && failedImage !== override.url ? override.url : undefined;
  const emoji = override?.kind === 'emoji' ? override.emoji : undefined;
  const accessibleLabel = label || `Group: ${group.name}`;
  useEffect(() => { setFailedImage(undefined); }, [group.id, override?.kind, override?.kind === 'photo' ? override.url : override?.kind === 'emoji' ? override.emoji : '']);

  return <span className={`group-avatar group-avatar-${size}${image ? ' has-group-avatar-image' : ''}${emoji ? ' has-group-avatar-emoji' : ''}`}
    data-group-id={group.id} role="img" aria-label={accessibleLabel} title={accessibleLabel}>
    {emoji ? <span aria-hidden="true">{emoji}</span> : image ? <img src={image} alt="" onError={() => setFailedImage(image)} /> : <Users size={size === 'xs' ? 12 : size === 'sm' ? 14 : size === 'lg' ? 20 : 16} aria-hidden="true" />}
  </span>;
}
