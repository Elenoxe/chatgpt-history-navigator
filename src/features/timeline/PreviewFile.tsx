import { useContext, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PreviewContext } from './PreviewContext';
import { fetchFileDownloadUrl, type PreviewFileTarget } from '@/platform/chatgpt/api';
import type { ReactNode } from 'react';

type PreviewFileProps = { name: ReactNode; image?: boolean; mimeType?: string } &
  ({ target: PreviewFileTarget; src?: never } | { src: string; target?: never });

export function PreviewFile({ target, src, name, image = false, mimeType = '' }: PreviewFileProps) {
  const context = useContext(PreviewContext);
  const scopedTarget = target && { ...target, projectId: target.projectId ?? context.projectId,
    sharedId: target.sharedId ?? context.sharedId, scopeConversationId: context.conversationId ?? undefined };
  const query = useQuery({
    queryKey: ['preview', context.userId, 'file', scopedTarget],
    enabled: !!target && !!context.userId,
    queryFn: ({ signal }) => fetchFileDownloadUrl(scopedTarget!, signal),
    staleTime: 60_000, gcTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const url = src ?? query.data;
  const [failedUrl, setFailedUrl] = useState<string>();
  const failed = query.isError || !!url && failedUrl === url;
  const fail = () => setFailedUrl(url);
  useEffect(() => {
    if (query.error) console.error('[chatgpt-history-navigator] Failed to resolve preview file:', query.error);
  }, [query.error]);
  return <span className="preview-attachment">
    {failed ? url ? <a href={url} target="_blank" rel="noopener noreferrer">{name}</a> : name
      : url ? mimeType.startsWith('audio/') ? <audio controls preload="none" src={url} onError={fail} />
      : mimeType.startsWith('video/') ? <video controls preload="metadata" src={url} onError={fail} />
      : image || mimeType.startsWith('image/') ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={typeof name === 'string' ? name : ''}
      loading="lazy" referrerPolicy="no-referrer" onError={fail} /></a>
      : <a href={url} target="_blank" rel="noopener noreferrer">{name}</a>
      : name}
  </span>;
}
