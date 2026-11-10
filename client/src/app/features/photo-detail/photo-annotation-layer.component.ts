import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { PhotoAnnotationsState } from './photo-annotations.state';

/**
 * Plugin annotations drawn over the photo (stars, planets, constellation lines...).
 *
 * The SVG's viewBox is the payload's own pixel frame (``payload.image``), so it
 * letterboxes exactly like the ``object-contain`` image beneath it, follows window
 * resizes with no measuring, and takes the same zoom transform. Labels are plain;
 * hovering or focusing an item shows its score and values in place of its label
 * (and as the native tooltip). The SVG itself never takes the pointer, only the
 * items do, and their presses bubble so panning started on one still pans.
 */
@Component({
  selector: 'app-photo-annotation-layer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (state.enabled()) {
      @for (v of state.views(); track v.source) {
        <svg class="absolute inset-0 w-full h-full pointer-events-none" data-annotation-layer
          [attr.viewBox]="v.viewBox" preserveAspectRatio="xMidYMid meet"
          [style.transform]="transform()" role="group" [attr.aria-label]="v.title">
          @for (d of v.drawn; track d.key) {
            <g class="pointer-events-auto outline-none" role="img" data-annotation
              [attr.tabindex]="d.labelPlaced ? 0 : -1"
              [attr.aria-label]="d.tooltip"
              (pointerenter)="state.hovered.set(d.key)" (pointerleave)="state.hovered.set(null)"
              (focus)="state.hovered.set(d.key)" (blur)="state.hovered.set(null)">
              <title>{{ d.tooltip }}</title>
              @if (d.shape === 'lines') {
                <path [attr.d]="d.d" fill="none" class="stroke-black/60" stroke-width="3.5"
                  stroke-linecap="round" vector-effect="non-scaling-stroke" />
                <path [attr.d]="d.d" fill="none" [attr.class]="d.strokeClass" stroke-width="1.5"
                  stroke-linecap="round" vector-effect="non-scaling-stroke" />
              } @else {
                <!-- Transparent fill so the whole marker answers hover, not just its thin ring. -->
                <circle [attr.cx]="d.x" [attr.cy]="d.y" [attr.r]="d.r" fill="transparent"
                  class="stroke-black/60" stroke-width="3.5" vector-effect="non-scaling-stroke" />
                <circle [attr.cx]="d.x" [attr.cy]="d.y" [attr.r]="d.r" fill="none"
                  [attr.class]="d.strokeClass"
                  [attr.stroke-width]="state.hovered() === d.key ? 3 : 1.5" vector-effect="non-scaling-stroke" />
              }
              @if (d.labelPlaced || state.hovered() === d.key) {
                <text [attr.x]="d.labelX" [attr.y]="d.labelY" [attr.font-size]="v.fontSize"
                  [attr.class]="d.fillClass + ' stroke-black/80 select-none'"
                  [attr.stroke-width]="v.fontSize / 5" paint-order="stroke" stroke-linejoin="round"
                  font-family="sans-serif" font-weight="600" aria-hidden="true">{{ state.hovered() === d.key ? d.tooltip : d.text }}</text>
              }
            </g>
          }
        </svg>
      }
    }
  `,
})
export class PhotoAnnotationLayerComponent {
  protected readonly state = inject(PhotoAnnotationsState);
  readonly transform = input<string>('');
}
