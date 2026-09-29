import type {SVGAttributes} from 'react';

// The Ask AI icon as a component, so it satisfies HIVE's IconType. `fill="currentColor"` follows the button's text
// colour (the static/ copy keeps its white fill for the modal header). No width/height: HIVE's Icon passes 1em
// and the viewBox scales to fit; props spread last so HIVE's values win.
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
