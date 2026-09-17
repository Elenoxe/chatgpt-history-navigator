import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { defaultUrlTransform, type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { visit } from 'unist-util-visit';
import type { ConversationMessage } from '@/platform/chatgpt/conversation';
import { getPreviewContent } from './previewContent';
import { ScrollFade } from './ScrollFade';
import 'katex/dist/katex.min.css';

// Only these parser-owned fields are needed to adapt ChatGPT's directives.
type DirectiveNode = {
  type: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string | null>;
  children?: DirectiveNode[];
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

function previewDirectives() {
  return (tree: DirectiveNode, file: { toString(): string }) => {
    visit(tree, node => {
      if (node.type === 'containerDirective' && node.name === 'writing') {
        node.data = { hName: 'section', hProperties: { className: 'preview-writing' } };
        const title = node.attributes?.title || node.attributes?.subject;
        if (title) node.children?.unshift({ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: title }] }] });
      } else if (node.type === 'textDirective' && node.name === 'previewReference') {
        node.data = { hName: 'span', hProperties: { 'data-preview-reference': node.children?.[0]?.value } };
      } else if (node.type.endsWith('Directive')) {
        // Unknown directives remain readable rather than silently dropping their syntax/content.
        node.type = 'text';
        node.value = file.toString().slice(node.position?.start.offset, node.position?.end.offset);
        delete node.children;
      }
    });
  };
}

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkDirective, previewDirectives];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex, [rehypeHighlight, { detect: false, plainText: ['mermaid'] }]];

export function MessagePreview({ message, title = false }: { message: ConversationMessage; title?: boolean }) {
  const { t } = useTranslation();
  const preview = useMemo(() => getPreviewContent(message, t('previewSource'), t('previewImage')), [message, t]);
  const components: Components = {
    a: ({ href, children }) => <span className={/^(app|plugin|skill):/.test(href ?? '') ? 'preview-mention'
      : /^(sandbox|attachment):/.test(href ?? '') ? 'preview-attachment' : 'preview-link'}>{children}</span>,
    img: ({ src, alt }) => title || !src ? <span>{alt}</span>
      : <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />,
    span: ({ node, children, ...props }) => {
      const index = node?.properties['data-preview-reference'];
      const reference = index === undefined ? undefined : preview.references[Number(index)];
      return reference ? <span className={`preview-${reference.kind}`} title={reference.label}>{reference.label}</span>
        : <span {...props}>{children}</span>;
    },
    table: ({ children }) => title ? <span>{children}</span>
      : <ScrollFade horizontal label={t('previewTable')}><table>{children}</table></ScrollFade>,
    pre: ({ children, node }) => {
      if (title) return <span>{children}</span>;
      const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
      const classes = code?.type === 'element' ? code.properties.className : [];
      const language = Array.isArray(classes) ? classes.find(value => String(value).startsWith('language-')) : undefined;
      return <div className="preview-code-block">
        {language && <div className="preview-code-language">{String(language).slice(9)}</div>}
        <pre>{children}</pre>
      </div>;
    },
  };
  return <>
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={title ? [] : rehypePlugins}
      components={components} skipHtml
      urlTransform={(url, key) => key === 'href' && /^(app|plugin|skill|sandbox|attachment):/.test(url) ? url : defaultUrlTransform(url)}>
      {preview.markdown || (title ? preview.attachments.map(item => item.name).join(', ') || t('timelineNonText') : '')}
    </Markdown>
    {!title && <>
      {preview.images.map((image, index) => image.src
        ? <img key={index} src={image.src} alt={image.alt} loading="lazy" referrerPolicy="no-referrer" />
        : <span key={index} className="preview-attachment">{image.alt}</span>)}
      {preview.attachments.map((attachment, index) => <span key={index} className="preview-attachment" title={attachment.type}>
        {attachment.name}{attachment.type && <small> · {attachment.type}</small>}
      </span>)}
    </>}
  </>;
}
