import { CategoryLabelPipe } from '../../shared/pipes/category-label.pipe';
import { I18nService } from '../../core/services/i18n.service';
import { Component, DestroyRef, computed, effect, inject, input, linkedSignal, output, signal, untracked, viewChild, viewChildren, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { TagNavigation } from '../../shared/models/tag-navigation';
import { catchError, of } from 'rxjs';
import { Photo, PhotoSet, hasExifFields } from '../../shared/models/photo.model';
import { ApiService } from '../../core/services/api.service';
import { FixedPipe } from '../../shared/pipes/fixed.pipe';
import { ShutterSpeedPipe } from '../../shared/pipes/shutter-speed.pipe';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { ThumbnailUrlPipe, PersonThumbnailUrlPipe } from '../../shared/pipes/thumbnail-url.pipe';
import { PhotoSetKindIconPipe, PhotoSetKindLabelPipe } from '../../shared/pipes/photo-set-kind.pipe';
import { EvOffsetPipe } from './burst-culling.pipes';
import { MomentLabelPipe } from '../scenes/scenes.pipes';
import { aspectOf } from './gallery-rows.util';
import { GalleryStore } from './gallery.store';
import { HISTOGRAM_TOOLTIP_HEIGHT } from '../../shared/components/histogram/histogram.component';
import { HistogramMode } from '../../shared/utils/histogram';
import { PhotoMetricsTabsComponent } from '../../shared/components/photo-metrics-tabs/photo-metrics-tabs.component';
import { CaptureDatePipe } from '../../shared/pipes/capture-date.pipe';
import { PhotoAssessmentComponent } from '../../shared/components/photo-assessment/photo-assessment.component';
import { CAMERA_METRICS, GRADE_METRICS, METRICS_TABS, type MetricsPanel, type MetricsTab } from '../../core/services/metrics-tab-state.service';
import { tagKinds } from '../../shared/utils/tag-kinds';
import { placeCard, type PlacementBox } from './card-placement';

export type TooltipSection = 'all' | 'grade' | 'camera' | 'content';

/** The album tags' fold key, beside the add-on ids (an add-on id never starts with a colon). */
const ALBUM_FOLD = ':album';

/** How long the pointer must rest on a photo before the tooltip fetches the
 *  frame count + EV span for its set. Kind and this frame's own EV offset are
 *  already on the Photo object and render with zero delay -- only the
 *  cross-photo fields (`GET /api/photo/set`) are worth debouncing across a
 *  dense gallery where the pointer crosses many tiles per second. */
/** Chips (and avatars) the floating hover card shows before folding the rest into "+N". */
const HOVER_CAP = 4;

const SET_INFO_DWELL_MS = 300;

/** The scores the floating bubble keeps: one per question a glance asks -- is it
 *  pleasing, well composed, sharp, well exposed. */
const KEY_SCORES = [
  { field: 'aesthetic', label: 'tooltip.aesthetic' },
  { field: 'comp_score', label: 'tooltip.composition' },
  { field: 'tech_sharpness', label: 'tooltip.tech_sharpness' },
  { field: 'exposure_score', label: 'tooltip.exposure' },
] as const;

// Intentionally keeps literal i18n keys instead of the shared I18N constants: this
// spec renders right after a Leaflet map spec, and the Angular Vitest builder shares
// one module registry per worker -- the map spec's module mock resets it and nulls
// this component's I18N import binding. Excluded in client/scripts/migrate-i18n.mjs.

@Component({
  selector: 'app-photo-tooltip',
  imports: [
    MatIconModule, MatMenuModule, NgTemplateOutlet, FixedPipe, ShutterSpeedPipe, TranslatePipe, ThumbnailUrlPipe, PersonThumbnailUrlPipe,
    CategoryLabelPipe, PhotoSetKindIconPipe, PhotoSetKindLabelPipe, EvOffsetPipe,
    MomentLabelPipe, PhotoMetricsTabsComponent, CaptureDatePipe, PhotoAssessmentComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (photo(); as p) {
      <!-- The class list stays a literal string: Tailwind only generates a
           utility it can see in the source, and an arbitrary value written as an
           escaped class binding is invisible to it (z-[1000] silently vanished
           that way). Docking overrides it through style bindings instead. -->
      <div #root
        class="fixed z-[1000] pointer-events-none flex flex-col p-3 rounded shadow-lg"
        [style.max-height]="docked() ? null : sheet() ? '60dvh' : 'calc(100vh - ' + (minTop() + 16) + 'px)'"
        [class.overflow-y-auto]="!docked()"
        [style.position]="docked() ? 'static' : null"
        [style.pointer-events]="showInteractiveControls() ? 'auto' : null"
        [style.width]="docked() || sheet() ? '100%' : null"
        [style.max-width]="docked() ? null : sheet() ? 'none' : 'min(640px, calc(100vw - 2rem))'"
        [style.padding]="docked() ? '16px' : null"
        [style.background]="docked() ? 'transparent' : 'var(--facet-tooltip-bg)'"
        [style.border]="docked() ? 'none' : '1px solid var(--facet-tooltip-border)'"
        [style.border-radius]="docked() ? '0' : sheet() ? '12px 12px 0 0' : null"
        [style.box-shadow]="docked() ? 'none' : null"
        [style.left.px]="docked() ? null : sheet() ? 0 : left()"
        [style.top.px]="docked() || sheet() ? null : top()"
        [style.bottom]="sheet() ? 'calc(4.5rem + env(safe-area-inset-bottom))' : null"
      >
        <!-- Zone A: Image + Scoring sections. The floating tooltip puts a
             portrait photo beside its numbers to stay within the viewport; the
             docked rail is a fixed narrow column, where that split leaves both
             halves too thin to read, so it always stacks. -->
        <div class="flex items-start gap-3"
          [class.flex-col]="isLandscape() || docked()"
          [class.flex-row-reverse]="!isLandscape() && !docked() && flipped()"
        >
          <!-- Image preview. Sized by its own aspect (max-w-full + w-auto) rather
               than stretched and letterboxed, so the box is the picture and the
               rounded corners show on every orientation. In the docked rail it
               takes the rail's width, so a portrait photo is as large as the column
               allows; only a very tall one is capped and contained. -->
          @if (shows().content) {
          <img
            [src]="p.path | thumbnailUrl:640:p.preview_revision"
            [alt]="p.filename"
            class="rounded-sm shrink-0 max-w-full h-auto"
            [class.w-auto]="!docked()"
            [class.max-h-[40vh]]="!isLandscape() && !docked()"
            [class.max-h-[28vh]]="isLandscape() && !docked()"
            [class.w-full]="docked()"
            [class.object-contain]="docked()"
            [class.max-h-[75dvh]]="docked()"
          />
          }

          <!-- Scoring panel -->
          <div class="text-xs leading-relaxed text-[var(--facet-tooltip-text)]"
            [class.min-w-[240px]]="!isLandscape() && !docked()"
            [class.max-w-[260px]]="!isLandscape() && !docked()"
            [class.w-full]="isLandscape() || docked()"
          >
            <!-- Filename + Date -->
            @if (shows().content) {
            <div class="font-semibold text-[var(--facet-tooltip-text-title)] truncate"
              [class.flex]="isLandscape()"
              [class.justify-between]="isLandscape()"
              [class.items-baseline]="isLandscape()"
              [class.gap-3]="isLandscape()"
            >
              <span class="truncate">{{ p.filename }}</span>
              @if (p.date_taken) {
                <span class="text-[var(--facet-tooltip-text-muted)] text-[11px] font-normal shrink-0"
                  [class.block]="!isLandscape()"
                data-capture-date>{{ p.date_taken | captureDate: locale() }}</span>
              }
            </div>

            <!-- Category + aggregate placed in the library like photo detail's,
               with the stars on their own line. -->
            @if (p.category) { <div class="flex items-center gap-2 mt-1 mb-1.5">
              <span class="text-xs text-[var(--facet-tooltip-text-secondary)] truncate">{{ p.category | categoryLabel }}</span>
            </div> }
            }
            @if (!docked()) { <app-photo-assessment [photo]="p" [range]="store.metricRangesByColumn()['aggregate']" [explainable]="explainable()" (explain)="explain.emit()" /> }
            @if (p.star_rating && shows().grade) {
              <div class="flex items-center gap-0.5 mb-1.5 text-yellow-400" role="img"
                   [attr.aria-label]="'rating.stars_out_of_five' | translate:{ stars: p.star_rating }">
                @for (star of stars; track star) {
                  <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">{{ star <= p.star_rating ? 'star' : 'star_border' }}</mat-icon>
                }
              </div>
            }

            <!-- Caption (after score) -->
            @if ((p.caption_translated || p.caption) && shows().content) {
              <!-- w-0 + min-w-full: the caption wraps inside the width the photo and
                   scores already give the bubble instead of widening it. -->
              <div class="w-0 min-w-full text-xs italic text-[var(--facet-tooltip-text-muted)] mb-1.5">{{ p.caption_translated || p.caption }}</div>
            }

            <!-- Narrative moment (with confidence) -->
            @if ((p.narrative_moment | momentLabel) && shows().content) {
              @let ml = p.narrative_moment | momentLabel;
              <div class="text-xs mb-1.5 flex items-center gap-1.5">
                <span class="text-[var(--mat-sys-primary)] font-medium">✦ {{ ml }}</span>
                @if (p.narrative_moment_confidence !== null && p.narrative_moment_confidence !== undefined) {
                  <span class="text-[var(--facet-tooltip-text-muted)]">{{ p.narrative_moment_confidence * 100 | fixed:0 }}%</span>
                }
              </div>
            }

            <!-- Floating: a glance, not the full sheet -- four fixed scores and one
                 EXIF line. Every other metric lives in the side
                 panel and photo detail, which the docked rail renders below. -->
            <!-- The docked Camera tab opens on the same capture line the bubble ends with. -->
            @if (docked() && section() === 'camera' && hasExif()) {
              <ng-container [ngTemplateOutlet]="captureLine" [ngTemplateOutletContext]="{ $implicit: p }" />
            }
            @if (!docked()) {
              <div data-floating-key-scores class="border-t border-[var(--facet-tooltip-divider)] pt-1.5 mt-1">
                @for (row of KEY_SCORES; track row.field) {
                  @if (p[row.field] !== null && p[row.field] !== undefined) {
                    <div class="flex items-baseline gap-2">
                      <span class="text-[var(--facet-tooltip-text-secondary)]">{{ row.label | translate }}</span>
                      <span class="ml-auto text-[var(--mat-sys-primary)] font-medium tabular-nums">{{ p[row.field] | fixed:1 }}</span>
                    </div>
                  }
                }
              </div>
              @if (hasExif()) {
                <ng-container [ngTemplateOutlet]="captureLine" [ngTemplateOutletContext]="{ $implicit: p }" />
              }
            }
            @if (!isLandscape() && !docked()) {
              <ng-container [ngTemplateOutlet]="details" />
            }
          </div>
        </div>
        @if (isLandscape() || docked()) {
          <ng-container [ngTemplateOutlet]="details" />
        }

        <!-- Zones B-D sit below the photo, except in a floating portrait bubble,
             where they join the column beside it so nothing spans under a tall
             image. -->
        <ng-template #captureLine let-p>
          <!-- Floating: w-0 + min-w-full, like the caption, so this nowrap line takes the width the
               photo and scores give the bubble instead of stretching it past the picture. -->
          <div data-capture-line class="mt-1.5 truncate text-[var(--facet-tooltip-text-secondary)] [&>span+span]:before:content-['_·_']"
               [class.w-0]="!docked()" [class.min-w-full]="!docked()">
            @if (p.camera_model) {<span>{{ p.camera_model }}</span>}
            @if (p.focal_length) {<span>{{ p.focal_length }}mm</span>}
            @if (p.f_stop) {<span>f/{{ p.f_stop }}</span>}
            @if (p.shutter_speed) {<span>{{ p.shutter_speed | shutterSpeed }}</span>}
            @if (p.iso) {<span>ISO {{ p.iso }}</span>}
          </div>
        </ng-template>
        <ng-template #details>
        <!-- Zone B: the docked rail's metric tabs, then the set strip; the floating
             bubble keeps only the set, its scores having been reduced above. -->
        @if (docked() && (shows().grade || shows().camera)) {
          <!-- Photo detail's metric tabs: all of them, or the Grade or Camera half, each with its remembered tab. -->
          <app-photo-metrics-tabs class="text-xs text-[var(--facet-tooltip-text)]" [photo]="p" [ranges]="store.metricRangesByColumn()"
                                  [sections]="metricSections()" [assessment]="section() !== 'camera'" [panel]="metricPanel()"
                                  [populated]="store.config()?.populated_scores"
                                  [histogramSrcSize]="160" [histogramHeight]="HISTOGRAM_TOOLTIP_HEIGHT"
                                  [histogramSurface]="'tooltip'" [histogramDefaultMode]="histogramDefaultMode()"
                                  [indicatorPercent]="indicatorPercent()" [explainable]="explainable()" (explain)="explain.emit()" />
        }
        <!-- Set (bracket/panorama/hdr_panorama/burst/duplicate). Kind and this
             frame's own EV offset are already on the photo object and render
             instantly; frame count and EV span come from a debounced, dwell-
             delayed GET /api/photo/set (see the constructor) and fill in once
             it resolves -- never blocking the rest of the bubble. Sibling
             thumbnails only in the docked panel: reaching for one in the
             floating hover bubble would dismiss it before the click could land. -->
        @if (shows().grade && setKind(); as kind) {
          <div class="mt-2 text-xs text-[var(--facet-tooltip-text)]" data-testid="tooltip-set">
            <div class="flex flex-wrap items-center gap-1.5">
              <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-[14px] opacity-70" aria-hidden="true">{{ kind | photoSetKindIcon }}</mat-icon>
              <span class="text-[var(--mat-sys-primary)] font-medium">{{ kind | photoSetKindLabel | translate }}</span>
              @if (photoSet(); as set) {
                <span class="text-[var(--facet-tooltip-text-secondary)]">{{ 'capsules.photos_count' | translate:{ count: set.count } }}</span>
                @if (set.ev_span !== null) {
                  <span class="text-[var(--facet-tooltip-text-secondary)]">{{ set.ev_span | fixed:1 }} EV</span>
                }
              }
              @if (p.sequence_ev_offset !== null && p.sequence_ev_offset !== undefined) {
                <span class="ml-auto text-[var(--facet-tooltip-text-secondary)]">{{ p.sequence_ev_offset | evOffset }}</span>
              }
            </div>
            @if (photoSet(); as set) {
              @if (docked() && set.members.length) {
                <div class="flex gap-2 flex-wrap mt-2">
                  @for (member of set.members; track member.path) {
                    <button type="button"
                            class="relative rounded-lg overflow-hidden w-14 h-14 shrink-0 cursor-pointer hover:opacity-80 transition-opacity ring-[var(--mat-sys-primary)]"
                            [class.ring-2]="member.path === p.path"
                            [attr.aria-label]="('photo_detail.set.member_position' | translate:{ position: $index + 1, count: set.members.length }) + (member.ev_offset !== null ? ', ' + (member.ev_offset | evOffset) : '')"
                            (click)="openSetMember(member.path)">
                      <img [src]="member.path | thumbnailUrl:96:member.preview_revision" alt="" class="w-full h-full object-cover" />
                      @if (member.ev_offset !== null) {
                        <span class="absolute bottom-0 inset-x-0 text-center text-[0.625rem] leading-4 bg-black/60 text-white">{{ member.ev_offset | evOffset }}</span>
                      }
                    </button>
                  }
                </div>
              }
            }
          </div>
        }

        <!-- Zone C: Tags (full width) -->
        @if (shows().content && navigationTags().length) {
          <div data-tags-row class="flex gap-1 mt-2 pt-1.5 border-[var(--facet-tooltip-divider)]" [class.flex-wrap]="docked()" [class.overflow-hidden]="!docked()" [class.border-t]="!docked()" [class.w-0]="!docked()" [class.min-w-full]="!docked()">
            @for (tag of shownTags(); track tag) {
              @if (personLinks() && showInteractiveControls()) {
                <button type="button" data-testid="tooltip-tag" [class.truncate]="!docked()" class="min-h-9 min-w-0 px-1.5 py-0.5 bg-[var(--facet-accent-badge)] text-[var(--facet-accent-text)] rounded text-[10px] hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mat-sys-primary)]"
                  [matMenuTriggerFor]="tagMenu" [matMenuTriggerData]="{ tag: tag }">{{ tag }}</button>
              } @else {
                <span [class.truncate]="!docked()" class="min-w-0 px-1.5 py-0.5 bg-[var(--facet-accent-badge)] text-[var(--facet-accent-text)] rounded text-[10px]">{{ tag }}</span>
              }
            }
            @if (hiddenTags() > 0) {
              <span data-tags-more class="shrink-0 px-0.5 py-0.5 text-[10px] text-[var(--facet-tooltip-text-muted)]"
                    [attr.aria-label]="'tooltip.more_count' | translate:{ count: hiddenTags() }">+{{ hiddenTags() }}</span>
            }
          </div>
        }
        <mat-menu #tagMenu="matMenu">
          <ng-template matMenuContent let-tag="tag">
            @if (tagCollectionAvailable()) {
              <button mat-menu-item (click)="onTagClick(tag, 'collection')"><mat-icon>filter_alt</mat-icon>{{ 'photo_detail.tag_refine_collection' | translate }}</button>
            }
            <button mat-menu-item (click)="onTagClick(tag, 'library')"><mat-icon>search</mat-icon>{{ 'photo_detail.tag_search_library' | translate }}</button>
          </ng-template>
        </mat-menu>

        <!-- Zone D: Person avatars. No label -- round face thumbnails are
             self-explanatory and the label was just noise competing for width
             in the rail. Clickable to filter the gallery by that person, but
             only where showInteractiveControls() holds: a plain hover bubble
             dismisses before a click could land, so an avatar there must stay
             a non-interactive image, not a button that looks clickable but
             is not. Bigger in the docked rail (w-11 = 44px, in the 40-48px
             legible-face range and a comfortable touch target) since it now
             has the width the removed label freed up; the floating bubble
             keeps the original 24px -- it is a dense scan-many-photos
             surface where large avatars would cost width against the
             scoring grid, whether or not it happens to be click-pinned. -->
        @if (shows().content && p.persons.length) {
          <div data-people-row class="flex items-center gap-1.5 mt-2 pt-1.5 border-[var(--facet-tooltip-divider)]" [class.flex-wrap]="docked()" [class.overflow-hidden]="!docked()" [class.border-t]="!docked()" [class.w-0]="!docked()" [class.min-w-full]="!docked()">
            @for (person of shownPersons(); track person.id) {
              @if (personLinks() && showInteractiveControls()) {
                <button type="button"
                        class="rounded-full ring-1 ring-[var(--facet-tooltip-divider)] cursor-pointer hover:opacity-80 transition-opacity overflow-hidden shrink-0"
                        [class.w-11]="docked()" [class.h-11]="docked()"
                        [class.w-6]="!docked()" [class.h-6]="!docked()"
                        [attr.aria-label]="'tooltip.filter_by_person' | translate:{ name: person.name }"
                        [title]="person.name"
                        (click)="onPersonClick(person.id)">
                  <img [src]="person.id | personThumbnailUrl" [alt]="person.name" class="w-full h-full object-cover" />
                </button>
              } @else {
                <img
                  [src]="person.id | personThumbnailUrl"
                  [alt]="person.name"
                  [title]="person.name"
                  class="w-6 h-6 shrink-0 rounded-full object-cover ring-1 ring-[var(--facet-tooltip-divider)]"
                />
              }
            }
            @if (hiddenPersons() > 0) {
              <span data-people-more class="shrink-0 text-[10px] text-[var(--facet-tooltip-text-muted)]"
                    [attr.aria-label]="'tooltip.more_count' | translate:{ count: hiddenPersons() }">+{{ hiddenPersons() }}</span>
            }
          </div>
        }

        <!-- Zone E: Object tags, what an add-on found: one folded row per add-on. The floating bubble keeps only
             the count (a glance should not wade through an add-on's bulk); the docked panel opens it to chips. -->
        @if (shows().content && objectGroups().length) {
          <div data-object-tags class="flex flex-col gap-1 mt-2 pt-1.5 border-[var(--facet-tooltip-divider)]" [class.border-t]="!docked()" [class.w-0]="!docked()" [class.min-w-full]="!docked()">
            @for (group of objectGroups(); track group.source) {
              @if (docked()) {
                <div data-object-tag-row [attr.data-source]="group.source" class="flex gap-1 flex-wrap items-center">
                  <button type="button" data-object-tag-group [attr.aria-expanded]="group.expanded"
                          class="inline-flex min-h-9 items-center gap-0.5 rounded-full border border-[var(--facet-tooltip-divider)] px-1.5 py-0.5 text-[10px] text-[var(--mat-sys-on-surface-variant)] cursor-pointer hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mat-sys-primary)]"
                          [attr.aria-label]="'photo_detail.object_tags.label' | translate:{ name: group.name, count: group.tags.length }"
                          (click)="toggleFold(group.source)">
                    <span aria-hidden="true">{{ (group.tags.length === 1 ? 'photo_detail.object_tags.summary_one' : 'photo_detail.object_tags.summary') | translate:{ name: group.name, count: group.tags.length } }}</span>
                    <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">{{ group.expanded ? 'expand_less' : 'chevron_right' }}</mat-icon>
                  </button>
                  @if (group.expanded) {
                    @for (tag of group.tags; track tag) {
                      <ng-container [ngTemplateOutlet]="mutedTag" [ngTemplateOutletContext]="{ $implicit: tag }" />
                    }
                  }
                </div>
              } @else {
                @if ($first) {
                  <span data-object-tag-count class="block truncate text-[10px] text-[var(--mat-sys-on-surface-variant)]">@if (objectGroups().length === 1) { {{ (group.tags.length === 1 ? 'photo_detail.object_tags.summary_one' : 'photo_detail.object_tags.summary') | translate:{ name: group.name, count: group.tags.length } }} } @else { {{ floatingObjectLine() }} }</span>
                }
              }
            }
          </div>
        }

        <!-- Zone F: Album tags, filing only, so only in the docked Content panel: muted, folded, last. Never in the
             floating bubble, which is the photo's description at a glance. -->
        @if (shows().content && docked() && albumTags().length) {
          <div data-album-tags class="flex gap-1 flex-wrap items-center mt-2 pt-1.5">
            <button type="button" data-album-tag-group [attr.aria-expanded]="albumExpanded()"
                    class="inline-flex min-h-9 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] text-[var(--mat-sys-on-surface-variant)] opacity-80 cursor-pointer hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mat-sys-primary)]"
                    [title]="'photo_detail.album_tags.hint' | translate"
                    [attr.aria-label]="'photo_detail.album_tags.label' | translate:{ count: albumTags().length }"
                    (click)="toggleFold(ALBUM_FOLD)">
              <span aria-hidden="true">{{ 'photo_detail.album_tags.summary' | translate:{ count: albumTags().length } }}</span>
              <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">{{ albumExpanded() ? 'expand_less' : 'chevron_right' }}</mat-icon>
            </button>
            @if (albumExpanded()) {
              @for (tag of albumTags(); track tag) {
                <ng-container [ngTemplateOutlet]="mutedTag" [ngTemplateOutletContext]="{ $implicit: tag }" />
              }
            }
          </div>
        }
        <!-- An object or album tag's chip: muted; in the interactive panel its menu filters by it, like a tag's. -->
        <ng-template #mutedTag let-tag>
          @if (personLinks() && showInteractiveControls()) {
            <button type="button" data-muted-tag class="min-h-9 px-1.5 py-0.5 rounded border border-[var(--facet-tooltip-divider)] text-[var(--mat-sys-on-surface-variant)] text-[10px] hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mat-sys-primary)]"
              [matMenuTriggerFor]="tagMenu" [matMenuTriggerData]="{ tag: tag }">{{ tag }}</button>
          } @else {
            <span data-muted-tag class="px-1.5 py-0.5 rounded border border-[var(--facet-tooltip-divider)] text-[var(--mat-sys-on-surface-variant)] text-[10px]">{{ tag }}</span>
          }
        </ng-template>
        </ng-template>

      </div>
    }
  `,
})
export class PhotoTooltipComponent {
  /** The viewer's language, the argument of the date pipes. */
  protected readonly locale = inject(I18nService).locale;
  readonly photo = input<Photo | null>(null);
  /** Clipping threshold for the histogram's markers, from `viewer.clipping`.
   *  Passed in rather than read from config here so the tooltip, the detail
   *  panel and the gallery badge cannot disagree about what counts as clipped. */
  readonly indicatorPercent = input(1);
  readonly x = input(0);
  readonly y = input(0);
  readonly flipped = input(false);
  /** A phone's bottom sheet: the card spans the screen's width along its bottom, above the selection bar. */
  readonly sheet = input(false);
  /** The photo the floating card belongs to (its box on screen), so the card can stay beside it. */
  readonly anchor = input<PlacementBox | null>(null);
  /** The floating card's highest top edge (the gallery passes the bottom of its toolbar). */
  readonly minTop = input(16);
  /**
   * Render docked in a column instead of floating at (x, y).
   *
   * Same content either way — what changes is that a docked panel stays in one
   * place, which is the whole point of the mode: comparing the same field
   * across photos is guesswork when the box moves with the cursor.
   */
  readonly docked = input(false);
  /**
   * Whether this bubble is held in place rather than dismissed by moving the
   * pointer -- a docked rail, or a floating bubble kept open by a click. Only
   * a pinned bubble can host the histogram's mode-toggle buttons: in plain
   * hover mode, moving the pointer toward them would dismiss the tooltip
   * before a click could ever land.
   */
  readonly pinned = input(false);
  /** False renders person avatars as plain images instead of filter buttons. */
  readonly personLinks = input(true);
  /** House default for the tooltip's OWN histogram channel mode, from
   *  `viewer.clipping.tooltip_histogram_mode` -- independent of the detail
   *  panel's default and of the user's per-surface persisted choice. */
  readonly histogramDefaultMode = input<HistogramMode>('luma');
  /**
   * Which part a docked panel shows, as the photo page splits it: `grade` (stars, AI score, Quality and
   * Composition, the set), `camera` (capture line, EXIF, Technical, Histogram), `content` (preview, name,
   * date, category, caption, moment, tags, people), or `all` (the floating bubble).
   */
  readonly section = input<TooltipSection>('all');
  protected readonly shows = computed(() => {
    const section = this.section();
    return { grade: section === 'all' || section === 'grade', camera: section === 'all' || section === 'camera', content: section === 'all' || section === 'content' };
  });
  protected readonly metricSections = computed<readonly MetricsTab[]>(() =>
    this.section() === 'grade' ? GRADE_METRICS : this.section() === 'camera' ? CAMERA_METRICS : METRICS_TABS);
  protected readonly metricPanel = computed<MetricsPanel>(() => {
    const section = this.section();
    return section === 'grade' || section === 'camera' ? section : '';
  });

  /** Whether the photo is landscape orientation (wider than tall).
   *
   *  Reads `aspectOf`, not the raw dimensions: those are null for a row whose
   *  fabricated size was cleared, and the aspect it kept still answers this. */
  readonly isLandscape = computed(() => {
    const p = this.photo();
    return p ? aspectOf(p) > 1 : false;
  });

  /** Whether any EXIF field is present. */
  readonly hasExif = computed(() => {
    const p = this.photo();
    if (!p) return false;
    return hasExifFields(p);
  });

  /** The set this frame resolves into, mirroring `GET /api/photo/set`'s own
   *  precedence (sequence, then burst, then duplicate) from fields already on
   *  the photo object -- 'burst' and 'duplicate' have no `sequence_kind`
   *  counterpart, since neither is a value that column can hold. */
  protected readonly setKind = computed(() => {
    const p = this.photo();
    if (!p) return null;
    if (p.sequence_kind) return p.sequence_kind;
    if (p.burst_group_id != null) return 'burst';
    if (p.duplicate_group_id != null) return 'duplicate';
    return null;
  });

  protected readonly HISTOGRAM_TOOLTIP_HEIGHT = HISTOGRAM_TOOLTIP_HEIGHT;
  protected readonly KEY_SCORES = KEY_SCORES;
  protected readonly stars: readonly number[] = [1, 2, 3, 4, 5];
  /** Whether this bubble is safe to host click targets beyond the
   *  toggle-the-photo click itself: the docked rail is always parked, and a
   *  click-pinned floating bubble does not dismiss on mouse-leave either (see
   *  onMouseLeave/hoverDriven() in photo-card.component.ts) -- only a plain
   *  hover bubble does, which is why it is excluded here. Gates the
   *  bubble's pointer-events and the person-avatar filter buttons. */
  protected readonly showInteractiveControls = computed(() => this.docked() || this.pinned());

  private readonly api = inject(ApiService);
  protected readonly store = inject(GalleryStore);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;
  // Bumped on every photo change so a slow response can't overwrite the set
  // info of the photo the pointer has already moved on to.
  private setGeneration = 0;

  /** Frame count + EV span for the photo's set (kind and this frame's own EV
   *  offset are already on `Photo` and need no fetch). null until the fetch
   *  resolves, or when the photo belongs to no set at all. */
  protected readonly photoSet = signal<PhotoSet | null>(null);

  private readonly rootEl = viewChild<ElementRef<HTMLElement>>('root');
  /** Measured size of the floating box; 0 until first measured. Content that
   *  arrives after the parent positioned the tooltip (image, set, faces,
   *  histogram) grows it, so the clamp must follow the real size. */
  private readonly measured = signal({ width: 0, height: 0 });
  private readonly viewport = signal({ width: window.innerWidth, height: window.innerHeight });

  /** Where the card goes once its real size is known: beside its photo (`anchor`), never over it, never above
   *  `minTop`. Content that arrives late (the image, the set, the histogram) grows the card, and a plain clamp
   *  to the viewport then slid it over its own photo, so the click that closes it could not reach the photo. */
  private readonly placement = computed(() => {
    const anchor = this.anchor();
    const { width, height } = this.measured();
    return anchor && width && !this.docked() && !this.sheet() ? placeCard(anchor, width, height, this.viewport(), this.minTop()) : null;
  });

  /** Top edge kept inside the viewport (16px margin) once the height is known. */
  protected readonly top = computed(() => {
    const placed = this.placement();
    if (placed) return placed.y;
    const y = this.y();
    const h = this.measured().height;
    if (!h) return y;
    return Math.max(this.minTop(), Math.min(y, this.viewport().height - h - 16));
  });

  /** Left edge kept inside the viewport (16px margin) once the width is known. */
  protected readonly left = computed(() => {
    const placed = this.placement();
    if (placed) return placed.x;
    const x = this.x();
    const w = this.measured().width;
    if (!w) return x;
    return Math.max(16, Math.min(x, this.viewport().width - w - 16));
  });

  constructor() {
    effect(() => {
      this.photo(); this.docked(); this.pinned(); this.personLinks();
      untracked(() => this.closeOverlays());
    });
    this.destroyRef.onDestroy(() => { this.destroyed = true; });
    const onResize = () => this.viewport.set({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    this.destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    effect(onCleanup => {
      const el = this.rootEl()?.nativeElement;
      if (!el || this.docked() || typeof ResizeObserver === 'undefined') return;
      const measure = () => {
        const r = el.getBoundingClientRect();
        this.measured.set({ width: r.width, height: r.height });
        this.viewport.set({ width: window.innerWidth, height: window.innerHeight });
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
    effect(onCleanup => {
      const p = this.photo();
      const token = ++this.setGeneration;
      untracked(() => this.photoSet.set(null));
      if (!p || !this.setKind()) return;
      const requestedPath = p.path;
      // Dwell delay: a pointer merely crossing many tiles never fires this
      // request at all, since each new photo cancels the previous timer.
      const timer = setTimeout(() => {
        const subscription = this.api
          .get<PhotoSet>('/photo/set', { path: requestedPath })
          .pipe(catchError(() => of(null)))
          .subscribe(res => {
            if (this.destroyed || token !== this.setGeneration) return;
            this.photoSet.set(res);
          });
        onCleanup(() => subscription.unsubscribe());
      }, SET_INFO_DWELL_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  /**
   * Open a sibling frame's own detail page (docked-panel sibling strip only).
   *
   * Chosen over swapping the panel's subject in place: every other sibling-
   * thumbnail strip in the app (photo-detail's own set block) already opens
   * the clicked frame's detail page, and a `PhotoSetMember` carries only a
   * path + EV offset -- not a full `Photo` -- so swapping in place would need
   * its own fetch anyway. One interaction for the one visual affordance, on
   * whichever surface it appears on. No `state: { photo }` pre-fetch payload
   * (unlike the gallery grid's own double-click-to-open): the destination
   * page's existing query-param fallback fetches it, same as a bookmarked link.
   */
  protected openSetMember(path: string): void {
    this.router.navigate(['/photo'], { queryParams: { path }, state: { photoOrigin: 'in-app' } });
  }

  /** Emits the clicked person's id, comma-list-formatted the way `person_id`
   *  filter values already are (a lone id is a valid one-element list) --
   *  see gallery-filter-sidebar.component.ts's own `ids.join(',')`. Only
   *  reachable where showInteractiveControls() renders the avatar as a
   *  button in the first place (docked rail, or a click-pinned floating
   *  bubble). The click REPLACES the current person filter rather than
   *  adding to it -- the more predictable outcome for a single click on one
   *  face -- while the sidebar's own multi-select remains the place to build
   *  up a filter across several people. */
  readonly personSelected = output<string>();
  readonly tagSelected = output<TagNavigation>();
  /** Opt-in "Why this score?" entry on the assessment line; the owner opens the critique. */
  readonly explainable = input(false);
  readonly explain = output<void>();
  private readonly menus = viewChildren(MatMenuTrigger);

  closeOverlays(): void {
    for (const menu of this.menus()) menu.closeMenu();
  }
  readonly tagCollectionAvailable = input(true);
  /** Add-on id -> its name ("Astro"), for the object-tag rows; the id stands in until the registry is read. */
  readonly addonNames = input<ReadonlyMap<string, string>>(new Map());
  /** The photo's tags by kind (F25d): Tags (AI + own), Object tags per add-on, Album tags. */
  private readonly kinds = computed(() => tagKinds(this.photo(), this.photo()?.manual_tag_sources ?? {}));
  /** Tags: what the photo shows, never an add-on's or an album's. */
  protected readonly navigationTags = computed(() => [...new Set([...this.kinds().ai, ...this.kinds().own])]);
  /** The floating hover card is one line per row: the first HOVER_CAP chips, the rest folded into a muted "+N". A fixed cap
   *  rather than a measured fit: it needs no layout pass, and a long chip truncates inside its row instead of wrapping. */
  protected readonly shownTags = computed(() => this.docked() ? this.navigationTags() : this.navigationTags().slice(0, HOVER_CAP));
  protected readonly hiddenTags = computed(() => this.navigationTags().length - this.shownTags().length);
  protected readonly shownPersons = computed(() => {
    const persons = this.photo()?.persons ?? [];
    return this.docked() ? persons : persons.slice(0, HOVER_CAP);
  });
  protected readonly hiddenPersons = computed(() => (this.photo()?.persons.length ?? 0) - this.shownPersons().length);
  /** Object tags on the hover card, several add-ons: "Astro 12 · Other 3" (one add-on uses the translated summary). */
  protected readonly floatingObjectLine = computed(() => this.objectGroups().map(g => `${g.name} ${g.tags.length}`).join(' · '));
  protected readonly albumTags = computed(() => this.kinds().album);
  protected readonly ALBUM_FOLD = ALBUM_FOLD;
  /** Folds opened on this photo (an add-on id, or the album fold); every photo starts folded. */
  private readonly openFolds = linkedSignal<string | undefined, ReadonlySet<string>>({
    source: () => this.photo()?.path, computation: () => new Set<string>(),
  });
  protected readonly albumExpanded = computed(() => this.openFolds().has(ALBUM_FOLD));
  protected readonly objectGroups = computed(() => {
    const names = this.addonNames();
    const open = this.openFolds();
    return this.kinds().objects.map(group => ({ ...group, name: names.get(group.source) ?? group.source, expanded: open.has(group.source) }));
  });

  protected toggleFold(key: string): void {
    this.openFolds.update(open => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  protected onTagClick(tag: string, scope: TagNavigation['scope']): void {
    if (!this.personLinks() || !this.showInteractiveControls() || (scope === 'collection' && !this.tagCollectionAvailable())) return;
    this.tagSelected.emit({ tag, scope });
  }

  protected onPersonClick(id: number): void {
    this.personSelected.emit(String(id));
  }
}
