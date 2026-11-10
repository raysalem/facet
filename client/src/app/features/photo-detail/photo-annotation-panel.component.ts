import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { i18nKeys } from '../../core/i18n/keys';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { PhotoAnnotationsState } from './photo-annotations.state';

/**
 * The annotations' controls, one compact block per source: group toggles, the
 * score slider, one slider per metric the plugin declared, "Show scores" and
 * "Show members", and the plugin's legend line. Every change filters the overlay
 * at once, client-side, and is remembered per browser and source.
 */
@Component({
  selector: 'app-photo-annotation-panel',
  imports: [MatButtonModule, MatCheckboxModule, MatIconModule, MatSliderModule, MatTooltipModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (state.enabled()) {
      @for (v of state.views(); track v.source) {
        <section class="rounded-lg border border-[var(--mat-sys-outline-variant)] p-3 space-y-2" data-annotation-panel
          [attr.aria-label]="v.title">
          <div class="flex items-center gap-2">
            <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">label</mat-icon>
            <span class="font-medium flex-1 truncate">{{ v.title }}</span>
            <span class="text-xs text-[var(--mat-sys-on-surface-variant)]" data-annotation-count>
              {{ I18N.photo_annotations.shown_count | translate:{ shown: v.shown, total: v.total } }}
            </span>
            <button mat-icon-button class="!w-7 !h-7 !min-w-0 !p-0 !inline-flex items-center justify-center"
              (click)="state.reset(v.source)"
              [matTooltip]="I18N.photo_annotations.reset | translate" [attr.aria-label]="I18N.photo_annotations.reset | translate">
              <mat-icon class="!text-base !w-4 !h-4 !leading-4">restart_alt</mat-icon>
            </button>
          </div>

          @if (v.groups.length) {
            <div class="flex flex-wrap gap-x-3">
              @for (g of v.groups; track g.id) {
                <mat-checkbox [checked]="g.on" (change)="state.setGroup(v.source, g.id, $event.checked)" [attr.data-group]="g.id">
                  <span class="inline-flex items-center gap-1">
                    <span class="inline-block w-2.5 h-2.5 rounded-full" [class]="g.swatch" aria-hidden="true"></span>{{ g.label }}
                  </span>
                </mat-checkbox>
              }
            </div>
          }

          @if (v.score; as sc) {
            <label class="flex items-center gap-2 text-xs">
              <span class="w-28 shrink-0">{{ sc.label }}</span>
              <mat-slider class="grow !mx-0" [min]="sc.min" [max]="sc.max" [step]="sc.step">
                <input matSliderThumb #scoreThumb [value]="sc.value" data-annotation-score
                  (input)="state.setScore(v.source, scoreThumb.valueAsNumber)" [attr.aria-label]="sc.label" />
              </mat-slider>
              <span class="w-10 text-right tabular-nums">≥ {{ sc.value }}</span>
            </label>
          }

          @for (m of v.metrics; track m.key) {
            <label class="flex items-center gap-2 text-xs">
              <span class="w-28 shrink-0">{{ m.label }}</span>
              <mat-slider class="grow !mx-0" [min]="m.min" [max]="m.max" [step]="m.step">
                <input matSliderThumb #metricThumb [value]="m.value" [attr.data-annotation-metric]="m.key"
                  (input)="state.setMetric(v.source, m.key, metricThumb.valueAsNumber)" [attr.aria-label]="m.label" />
              </mat-slider>
              <span class="w-10 text-right tabular-nums">{{ m.value }}</span>
            </label>
          }

          <div class="flex flex-wrap gap-x-3">
            <mat-checkbox [checked]="v.showScores" (change)="state.setShowScores(v.source, $event.checked)" data-show-scores>
              {{ I18N.photo_annotations.show_scores | translate }}
            </mat-checkbox>
            @if (v.hasMembers) {
              <mat-checkbox [checked]="v.showMembers" (change)="state.setShowMembers(v.source, $event.checked)" data-show-members>
                {{ I18N.photo_annotations.show_members | translate }}
              </mat-checkbox>
            }
          </div>

          @if (v.legend) {
            <div class="text-xs text-[var(--mat-sys-on-surface-variant)]" data-annotation-legend>{{ v.legend }}</div>
          }
        </section>
      }
    }
  `,
})
export class PhotoAnnotationPanelComponent {
  protected readonly state = inject(PhotoAnnotationsState);
  protected readonly I18N = i18nKeys();
}
