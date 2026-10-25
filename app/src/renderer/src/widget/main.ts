import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/silkscreen/400.css';
import './widget.css';
import type { Bridge } from '../../../shared/types';
import { mockBridge } from '../lib/mock';
import { PortalWidget } from './portal';

const bridge: Bridge = (window as unknown as { zack?: Bridge }).zack ?? mockBridge();
const widget = new PortalWidget(document.getElementById('portal')!, bridge);
void widget.start();

// in a plain browser, a few keys drive the fake other side
const demo = (bridge as ReturnType<typeof mockBridge>).demo;
if (demo) {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'i') demo.incoming();
    if (e.key === 'o') demo.offline(true);
    if (e.key === 'O') demo.offline(false);
    if (e.key === 'l') demo.linked();
    if (e.key === '1') demo.theme('singularity');
    if (e.key === '2') demo.theme('warp');
    if (e.key === '3') demo.theme('rift');
  });
}
