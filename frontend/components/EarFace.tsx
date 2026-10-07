export type EarExpression = 1 | 2 | 3 | 4 | 5;

const mouths: Record<EarExpression, string> = {
  1: 'M81 78q9-10 18 0',
  2: 'M82 77q8-5 16 0',
  3: 'M82 76h16',
  4: 'M84 74q6 6 12 0',
  5: 'M80 73q10 17 20 0',
};

export function EarFace({
  expression = 4,
  ears = true,
}: {
  expression?: EarExpression;
  ears?: boolean;
}) {
  return (
    <>
      {ears && (
        <>
          <g data-part="left-ear" className="origin-right [transform-box:fill-box]">
            <path
              d="M64 50C61 31 40 27 29 42C15 61 25 77 39 82C46 85 43 96 53 96C65 96 70 73 64 50Z"
              className="fill-card"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M49 43C35 37 27 54 37 63C45 68 36 75 44 79M45 51C38 50 37 57 43 60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
          <g data-part="right-ear" className="origin-left [transform-box:fill-box]">
            <path
              d="M116 50C119 31 140 27 151 42C165 61 155 77 141 82C134 85 137 96 127 96C115 96 110 73 116 50Z"
              className="fill-card"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M131 43C145 37 153 54 143 63C135 68 144 75 136 79M135 51C142 50 143 57 137 60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        </>
      )}
      <g data-part="face" className="origin-center [transform-box:fill-box]">
        <path
          d="M65 51C69 35 111 35 115 51L119 79C119 98 61 98 61 79Z"
          className="fill-card"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M69 86q21 12 42 0"
          stroke="currentColor"
          opacity=".12"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <g data-part="eyes">
          {expression === 5 ? (
            <path
              d="M74 63q5-8 10 0M96 63q5-8 10 0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          ) : (
            <>
              <ellipse cx="79" cy="62" rx="3" ry="4" fill="currentColor" />
              <ellipse
                data-part="right-eye"
                cx="101"
                cy="62"
                rx="3"
                ry="4"
                fill="currentColor"
                className="origin-center [transform-box:fill-box]"
              />
            </>
          )}
          {expression < 3 && (
            <path
              d={expression === 1 ? 'M74 51l10 5M96 56l10-5' : 'M74 55l10-3M96 52l10 3'}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}
          <path
            d={mouths[expression]}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
        <circle cx="71" cy="72" r="4" fill="currentColor" opacity=".1" />
        <circle cx="109" cy="72" r="4" fill="currentColor" opacity=".1" />
      </g>
    </>
  );
}
