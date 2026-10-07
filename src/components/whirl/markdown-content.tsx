import { isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

/* A code block wearing the app's well treatment — header strip with a copy
   affordance, body that scrolls sideways instead of pushing the column. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, '');
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl bg-well shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)]">
      <div className="flex h-8 items-center justify-between gap-3 px-3 text-[11px] text-muted-foreground">
        <span>Code</span>
        <button
          type="button"
          aria-label="Copy code block"
          onClick={() => {
            navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }).catch(() => {});
          }}
          className="flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 opacity-0 transition-[opacity,background-color] duration-150 group-hover/code:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="wb-scroll overflow-x-auto px-3 pb-3 text-[13px]/6">
        <code className="font-mono">{children}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      {...props}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('wb-markdown min-w-0', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>{children}</ReactMarkdown>
    </div>
  );
});
