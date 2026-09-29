// Types `.module.scss` imports; Docusaurus only ships types for *.module.css.
declare module '*.module.scss' {
  const classes: {readonly [key: string]: string};
  export default classes;
}
