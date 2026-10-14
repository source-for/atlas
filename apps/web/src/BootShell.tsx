import type { CSSProperties } from 'react';
import { bootShellStepLabel, type BootShellHeaderSlot, type BootShellLayout, type BootShellStep } from './bootShellState';
import { LayersIcon, SearchIcon, SourceForMark } from './icons';

/**
 * CLA-268: the atlas shell skeleton (see bootShellState.ts). It uses App's own shell classes so every region sits in the
 * box App will occupy, and it holds no controls: nothing in it can take focus or be clicked. Its one live region
 * names the boot step in progress. The wordmark stays hidden until its webfont has loaded: drawn in the fallback face
 * first, its words would move when the face swaps in.
 *
 * Accessibility: everything but the step line is hidden from assistive technology (the header too, so no empty banner
 * landmark is exposed). The step line is a polite live region with no `aria-busy` ancestor: the skeleton is replaced by
 * App rather than ever going un-busy, so a busy ancestor could hold its announcements for good.
 */
export function BootShell({ layout, step, headerSlots, fontsReady }: { layout: BootShellLayout; step: BootShellStep; headerSlots: readonly BootShellHeaderSlot[]; fontsReady: boolean }) {
  const label = bootShellStepLabel(step);
  return <div className="app-shell boot-shell" data-boot-step={step} data-embed={layout.embed ? 'true' : 'false'} data-fonts={fontsReady ? 'ready' : 'pending'} data-shell-skeleton="">
    <header aria-hidden="true" className="topbar">
      <div className="brand-block">
        <SourceForMark className="brand-mark" size={30}/>
        <div><div className="brand-line"><strong>Source For</strong><span className="brand-name">Atlas</span><span className="brand-product">PREVIEW</span></div></div>
      </div>
      <div className="search-zone">
        <div className="search-trigger"><SearchIcon size={16}/><span>Find a system, flow, or source file…</span><kbd>⌘ K</kbd></div>
      </div>
      <div className="top-actions">
        {headerSlots.map(slot => <HeaderSlot key={slot} slot={slot}/>)}
      </div>
    </header>

    <div aria-hidden="true" className="diagram-view-bar">
      <div className="diagram-tabs"><div className="diagram-tab-shell active"><span className="diagram-tab"><span>Main</span></span></div></div>
    </div>

    <div className={`workspace ${layout.detailsOpen ? 'has-details' : ''}`} style={{ '--details-width': `${layout.detailsWidth}px` } as CSSProperties}>
      <section className="map-stage">
        <div aria-hidden="true" className="atlas-canvas boot-canvas"/>
        <p className="boot-status" role="status">{label}</p>
        <div aria-hidden="true" className="level-rail">
          <div className="rail-icon"><LayersIcon/></div>
          {['L1', 'L2', 'L3', 'L4'].map(level => <span className="boot-rail-level" key={level}>{level}</span>)}
        </div>
        <div aria-hidden="true" className="canvas-hint"><span>Pinch or wheel to zoom</span><i/>drag to pan<i/>click to inspect<i/>double-click to open inside</div>
      </section>
      <div aria-hidden="true" className={`details-panel ${layout.detailsOpen ? 'open' : ''}`}>
        <div className="details-header"><div className="details-header-title"><span>OVERVIEW</span><small>Architecture brief</small></div></div>
        <div className="inspector-tabs"><span className="boot-tab active">Overview</span><span className="boot-tab">Source</span><span className="boot-tab">Details</span></div>
        <div className="details-scroll">
          <span className="boot-line" style={{ width: '46%' }}/>
          <span className="boot-line boot-line-title" style={{ width: '72%' }}/>
          <span className="boot-line" style={{ width: '92%' }}/>
          <span className="boot-line" style={{ width: '84%' }}/>
          <span className="boot-line" style={{ width: '64%' }}/>
        </div>
      </div>
    </div>
  </div>;
}

/** Empty, inert stand-ins with the classes of App's controls (a `<details>` menu and the embed wrapper included). */
function HeaderSlot({ slot }: { slot: BootShellHeaderSlot }) {
  if (slot === 'screenshot') return <span className="diagram-add-menu screenshot-menu"><span className="boot-menu-summary"/></span>;
  if (slot === 'embed') return <span className="embed-atlas-control"><span className="icon-button embed-atlas-button"/></span>;
  return <span className={slot === 'share' ? 'icon-button share-view-button' : 'icon-button'}/>;
}
