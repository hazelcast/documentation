import type {SVGAttributes} from 'react';

// The Antora theme's ask-ai-icon.svg as a component, so it satisfies HIVE's
// IconType and takes its colour from the button it sits in. Two deliberate
// differences from the file it came from:
//
//   - `fill="currentColor"` replaces the baked `#FAFAFA`. That white was right
//     for Antora's accent-coloured button; here the icon has to follow whatever
//     the HIVE variant's text colour is. The static copy at
//     static/img/kapa/ask-ai-icon.svg KEEPS the white fill -- that one is the
//     modal header logo (data-project-logo), on a teal ground.
//   - The <clipPath> is dropped. Its rect spans the full extent of all three
//     paths, so it clipped nothing, and an inlined duplicate id is a real cost.
//
// No width/height: HIVE's Icon passes `width="1em" height="1em"`, and SVG's
// default preserveAspectRatio fits this 15x19 viewBox inside that square
// without distorting it. Props spread last so HIVE's values win.
export default function AskAiIcon(props: SVGAttributes<SVGElement>) {
  return (
    <svg viewBox="0 0 15 19" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M9.04087 7.24823L10.3031 11.4582L14.3376 12.7753L10.3031 14.0923L9.04087 18.3023L7.77869 14.0923L3.74414 12.7753L7.77869 11.4582L9.04087 7.24823Z"
        fill="currentColor"
      />
      <path
        d="M5.44602 0.697632L6.42918 4.42705L10.1752 5.40584L6.42918 6.38463L5.44602 10.114L4.46286 6.38463L0.716797 5.40584L4.46286 4.42705L5.44602 0.697632Z"
        fill="currentColor"
      />
      <path
        d="M12.5878 4.79187L13.0893 6.8594L14.9999 7.40203L13.0893 7.94465L12.5878 10.0122L12.0864 7.94465L10.1758 7.40203L12.0864 6.8594L12.5878 4.79187Z"
        fill="currentColor"
      />
    </svg>
  );
}
