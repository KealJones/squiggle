const squiggleWait = () => h('span', { class: 'squiggle-wait', role: 'status', 'aria-label': 'Working', html: WAVE });

// The SVG template is modified here to animate the transform attribute instead of the path data.
const WAVE = `<svg viewBox="0 0 48 16" aria-hidden="true"><path d="${frame(0)}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`(still ? '' : `<animate 
attributeName="transform" 
from="translateY(0)" 
to="translateY(-10)" 
dur="1.4s" 
repeatCount="indefinite" 
keyTimes="0;1" 
calcMode="spline" 
keySplines="0.618,1,1,0.618"/>`) + '</path></svg>';

