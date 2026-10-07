import { lazy, Suspense } from 'react';

const Content = lazy(() => import('./markdown-content').then(module => ({ default: module.Markdown })));

export function Markdown(props: { children: string; className?: string }) {
  return <Suspense fallback={<div className="whitespace-pre-wrap break-words">{props.children}</div>}><Content {...props} /></Suspense>;
}
