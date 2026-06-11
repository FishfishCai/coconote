// esbuild bundles .md imports as text (--loader:.md=text).
declare module "*.md" {
  const text: string;
  export default text;
}
