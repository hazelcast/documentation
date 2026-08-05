// Lets TypeScript accept CSS-Modules `.module.scss` imports (e.g. borrowing
// HIVE's compiled @hazelcast/ui/lib/components/Badge.module.scss classes).
// Docusaurus ships types for *.module.css but not *.module.scss.
declare module '*.module.scss' {
  const classes: {readonly [key: string]: string};
  export default classes;
}
