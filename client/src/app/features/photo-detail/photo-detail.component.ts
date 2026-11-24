import { ControlPopoverComponent } from '../../shared/components/control-popover/control-popover.component';
import { I18nService } from '../../core/services/i18n.service';
import { LogicalAssetApplied } from '../../shared/models/logical-asset-change';
import { buildSyncParams } from '../gallery/gallery-filters.util';
import { refineTagQuery } from '../gallery/tag-query.util';
import { GALLERY_REVISIT } from '../../core/gallery-reuse.strategy';
import { PhotoCollectionSidebarComponent } from './photo-collection-sidebar.component';
import { LogicalReviewService, LogicalReviewAction, LogicalReviewWriteError } from '../../core/services/logical-review.service';
import { PhotoProvenanceComponent } from './photo-provenance.component';
import { PhotoRelatedFilesComponent } from './photo-related-files.component';
import { PhotoAlbumsComponent } from './photo-albums.component';
import { TimelineFeedCache } from '../timeline/timeline-feed-cache.service';
import { Component, inject, signal, computed, linkedSignal, effect, untracked, OnInit, HostListener, DestroyRef, ElementRef, viewChild, ChangeDetectionStrategy, Injector, afterNextRender } from '@angular/core';
import { Location, NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, NavigationStart, NavigationEnd } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, skip, finalize } from 'rxjs';
import { UserActivityJournal } from '../../core/agent/user-activity-journal.service';
import { AssistantChangeBatch, AssistantChangesService } from '../../core/agent/assistant-changes.service';
import { Photo, KeeperHint, PhotoSet, PhotoSetMember, normalisePhotoFlags } from '../../shared/models/photo.model';
import { AuthService } from '../../core/services/auth.service';
import { StalenessGuardFactory } from '../../core/services/staleness-guard.service';
import { PhotoActionsService } from '../../core/services/photo-actions.service';
import { PhotoDetailBase } from '../../shared/directives/photo-detail-base.directive';
import { ZoomPanDirective } from '../../shared/directives/zoom-pan.directive';
import { PhotoObjectLayerComponent } from './photo-object-layer.component';
import { PhotoAnnotationLayerComponent } from './photo-annotation-layer.component';
import { PhotoAnnotationsState } from './photo-annotations.state';
import { FixedPipe } from '../../shared/pipes/fixed.pipe';
import { CaptureDatePipe } from '../../shared/pipes/capture-date.pipe';
import { RenditionReadoutComponent } from '../../shared/components/rendition-readout/rendition-readout.component';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { ThumbnailUrlPipe } from '../../shared/pipes/thumbnail-url.pipe';
import { PersonThumbnailUrlPipe } from '../../shared/pipes/thumbnail-url.pipe';
import { FilenamePipe } from '../../shared/pipes/filename.pipe';
import { CategoryLabelPipe } from '../../shared/pipes/category-label.pipe';
import { DownloadIconPipe } from '../../shared/pipes/download-icon.pipe';
import { PhotoSetKindIconPipe, PhotoSetKindLabelPipe } from '../../shared/pipes/photo-set-kind.pipe';
import { SEQUENCE_KINDS_KEPT_WHOLE } from '../../shared/pipes/sequence-kind.pipe';
import { EvOffsetPipe } from '../gallery/burst-culling.pipes';
import {
  HISTOGRAM_PANEL_HEIGHT,
} from '../../shared/components/histogram/histogram.component';
import { PhotoMetricsTabsComponent } from '../../shared/components/photo-metrics-tabs/photo-metrics-tabs.component';
import { HistogramMode, isHistogramMode } from '../../shared/utils/histogram';
import { ComparisonCategoryExplainerComponent } from '../comparison/comparison-category-explainer.component';
import { DownloadOption } from '../../core/api/types';
import { downloadFile } from '../../shared/utils/download';
import { basename } from '../../shared/utils/clipboard';
import { GalleryStore } from '../gallery/gallery.store';
import { aspectOf } from '../gallery/gallery-rows.util';
import { setScopePatch } from '../gallery/gallery-filters.util';
import * as L from 'leaflet';
import { createLeafletMap, OSM_TILES } from '../../shared/leaflet';
import { MapSourcePreferences } from '../../core/services/map-source-preferences.service';
import { I18N, i18nKeys } from '../../core/i18n/keys';
import { isPageShortcutBlocked } from '../../shared/utils/keyboard';
import { privateImageSessionKey } from '../../shared/utils/private-image-session';
import { KeyboardMappingService } from '../../core/services/keyboard-mapping.service';
import { AddonRail } from '../../core/addons/addon-rail';
import { CAMERA_METRICS, GRADE_METRICS } from '../../core/services/metrics-tab-state.service';
import { PanelRailComponent } from '../../shared/components/panel-rail/panel-rail.component';
import { definingFilters, galleryFilterChips } from '../gallery/gallery-filter-chips';
import { PluralKeyPipe } from '../../shared/pipes/plural-key.pipe';
import { PanelWidth } from '../../shared/utils/panel-width';
import { PanelResizeHandleComponent } from '../../shared/components/panel-resize-handle/panel-resize-handle.component';
import { tagKinds } from '../../shared/utils/tag-kinds';
import type { CategoryOverrideResult } from './category-override-dialog.component';
import { StackNavigatorComponent } from './stack-navigator.component';
import { PhotoStackService } from '../../core/services/photo-stack.service';
import { PhotoFaceLayerComponent } from './photo-face-layer.component';
import { PersonFaceMenuComponent } from '../persons/person-face-menu.component';
import {
  FaceBoxMode, FACE_BOX_MODE_ICONS, FACE_BOX_MODE_LABELS, nextFaceBoxMode, readFaceBoxMode, writeFaceBoxMode,
} from './face-box-mode';
import { captureSession } from '../../shared/utils/auth-session';

interface PhotoTagOrigin {
  owner: string;
  params: Record<string, string>;
  refinable: boolean;
}

const LOCATION_OPEN_KEY = 'facet_photo_location_open';
/** The key an add-on's objects chip opens under, beside its tag group's own key. */
const OBJECTS = 'objects:';
/** The album tags' fold, kept with the add-on folds (an add-on id never starts with a colon). */
const ALBUM = ':album';
type FacetTab = 'grade' | 'camera' | 'content' | 'filter';

/**
 * Model D fields of `GET /api/photo` (no share token): the summary tags each add-on wrote, and how many
 * detections it indexed. Kept here, not on `Photo`, until the server on this branch sends them; absent,
 * the page shows exactly what it showed before.
 */
interface AddonPhotoFields {
  plugin_tags?: readonly { tag: string; source: string }[] | null;
  detections?: readonly { source: string; count: number }[] | null;
}
type DetectionLabels = readonly string[] | 'loading' | 'failed';

function readLocationOpen(): boolean {
  try { return localStorage.getItem(LOCATION_OPEN_KEY) === 'true'; } catch { return false; }
}

const SOCIAL_SOURCE_KEYS: Record<string, string> = {
  saliency: I18N.social_export.source.saliency,
  faces: I18N.social_export.source.faces,
  center: I18N.social_export.source.center,
};


/** Whether `row` is in the set `/photo/set` lists for `current`: its sequence, else its
 *  burst, else its duplicate group, the server's order (`api/routers/gallery.py`). */
function sharesSet(row: Photo, current: Photo): boolean {
  if (current.sequence_kind && current.sequence_group_id != null) {
    return row.sequence_kind === current.sequence_kind && row.sequence_group_id === current.sequence_group_id;
  }
  if (current.burst_group_id != null) return row.burst_group_id === current.burst_group_id;
  return current.duplicate_group_id != null && row.duplicate_group_id === current.duplicate_group_id;
}

/** Whether a row says it belongs to a detected set, before `/photo/set` has listed it. */
function inDetectedSet(photo: Photo): boolean {
  return (!!photo.sequence_kind && photo.sequence_group_id != null) || photo.burst_group_id != null || photo.duplicate_group_id != null;
}

@Component({
  selector: 'app-photo-detail',
  imports: [ControlPopoverComponent, PhotoCollectionSidebarComponent, PhotoProvenanceComponent, PhotoRelatedFilesComponent, PhotoAlbumsComponent,
    StackNavigatorComponent, NgTemplateOutlet, PanelRailComponent, PanelResizeHandleComponent,
    ZoomPanDirective,
    PhotoObjectLayerComponent,
    PhotoAnnotationLayerComponent,
    PhotoMetricsTabsComponent,
    PhotoFaceLayerComponent,
    PersonFaceMenuComponent,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    FixedPipe, MatExpansionModule,
    CaptureDatePipe, RenditionReadoutComponent,
    TranslatePipe, PluralKeyPipe,
    ThumbnailUrlPipe,
    PersonThumbnailUrlPipe,
    CategoryLabelPipe, FilenamePipe,
    DownloadIconPipe,
    PhotoSetKindIconPipe,
    PhotoSetKindLabelPipe,
    EvOffsetPipe,
    ComparisonCategoryExplainerComponent,
  ],
  // One annotations state per photo page, read by the overlay layer.
  providers: [PhotoAnnotationsState],
  template: `
    @if (photo(); as p) {
      <!-- Header bar -->
      <div data-photo-detail-header class="@container flex max-md:flex-wrap shrink-0 items-center gap-2 px-2 py-1 border-b border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-lowest)]">
        <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" (click)="goBack()" [matTooltip]="I18N.photo_detail.back | translate" [attr.aria-label]="I18N.photo_detail.back | translate">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <h1 class="m-0 min-w-0 flex-1 truncate text-base font-medium leading-6 max-md:whitespace-normal max-md:[overflow-wrap:anywhere] max-md:line-clamp-2 max-md:order-last max-md:basis-full" [title]="p.filename"><span class="md:hidden" aria-hidden="true">{{ p.filename | filename:64 }}</span><span class="max-md:sr-only">{{ p.filename }}</span></h1>
        @if (auth.isEdition()) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" (click)="refreshPhoto(p)" [matTooltip]="I18N.photo_refresh.title | translate" [attr.aria-label]="I18N.photo_refresh.title | translate"><mat-icon>refresh</mat-icon></button>
        }


        @if (store.config()?.features?.show_similar_button) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" [matMenuTriggerFor]="similarMenu"
            [matTooltip]="I18N.similar.find_similar | translate" [attr.aria-label]="I18N.similar.find_similar | translate">
            <mat-icon>image_search</mat-icon>
          </button>
        }

        @if (store.config()?.features?.show_critique) {
          <button mat-button class="!min-w-11 !h-11 !px-2" (click)="openCritique(p)"
            [matTooltip]="I18N.photo_detail.analysis | translate" [attr.aria-label]="I18N.photo_detail.analysis | translate">
            <mat-icon class="!m-0 @min-[960px]:!mr-2">analytics</mat-icon><span class="hidden @min-[960px]:inline">{{ I18N.photo_detail.analysis | translate }}</span>
          </button>
        }

        @if (auth.isEdition() && p.is_rejected && !p.is_kept) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 !text-[var(--mat-sys-error)]" (click)="removeFromCatalog()"
            [matTooltip]="I18N.photo_detail.remove_catalog.action | translate" [attr.aria-label]="I18N.photo_detail.remove_catalog.action | translate">
            <mat-icon>hide_image</mat-icon>
          </button>
        }

        @if (auth.isEdition() && p.is_rejected && !p.is_kept && store.config()?.cull?.trash_available) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden !text-[var(--mat-sys-error)]" (click)="deletePhoto()"
            [matTooltip]="I18N.photo_detail.delete.button_label | translate" [attr.aria-label]="I18N.photo_detail.delete.button_label | translate">
            <mat-icon>delete</mat-icon>
          </button>
        }

        @if (auth.isEdition()) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" [matMenuTriggerFor]="categoryOverrideMenu"
            [matTooltip]="I18N.photo.category_override.menu_tooltip | translate" [attr.aria-label]="I18N.photo.category_override.menu_tooltip | translate">
            <mat-icon>category</mat-icon>
          </button>
        }

        <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" (click)="cycleFaceBoxMode()"
          data-face-box-mode
          [matTooltip]="faceBoxModeLabel() | translate"
          [attr.aria-label]="faceBoxModeLabel() | translate">
          <mat-icon>{{ faceBoxModeIcon() }}</mat-icon>
        </button>

        @if (auth.isEdition()) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" (click)="openManualFaces(p)"
            [matTooltip]="I18N.manual_faces.title | translate" [attr.aria-label]="I18N.manual_faces.title | translate">
            <mat-icon>highlight_alt</mat-icon>
          </button>
        }

        @if (auth.isEdition() && p.unassigned_faces > 0) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" (click)="openAddPerson(p)"
            [matTooltip]="I18N.manage_persons.assign_face | translate" [attr.aria-label]="I18N.manage_persons.assign_face | translate">
            <mat-icon>person_add</mat-icon>
          </button>
        }

        <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" data-copy-photo
          (click)="copyPhoto(p.path)" [disabled]="copyingPhoto()" [matTooltip]="I18N.photo_detail.copy_image | translate"
          [attr.aria-label]="I18N.photo_detail.copy_image | translate">
          @if (copyingPhoto()) { <mat-spinner diameter="18" aria-hidden="true" /> } @else { <mat-icon>content_copy</mat-icon> }
        </button>
        @if (downloadOptions().length > 1) {
          <button mat-button class="!min-w-11 !h-11 !px-2" [matMenuTriggerFor]="downloadMenu" [disabled]="downloading()" [matTooltip]="I18N.photo_detail.download | translate"
            [attr.aria-label]="(downloading() ? I18N.photo_detail.downloading : I18N.photo_detail.download) | translate">
            @if (downloading()) { <mat-spinner diameter="18" class="!inline-block" aria-hidden="true" /> } @else { <mat-icon class="!m-0 @min-[960px]:!mr-2">download</mat-icon> }
            <span class="hidden @min-[960px]:inline">{{ I18N.photo_detail.download | translate }}</span>
          </button>
          <mat-menu #downloadMenu="matMenu">
            @for (opt of downloadOptions(); track opt.type + (opt.profile ?? '')) {
              <button mat-menu-item (click)="download(p.path, opt.type, opt.profile ?? undefined)">
                <mat-icon>{{ opt.type | downloadIcon }}</mat-icon>
                @if (opt.type === 'darktable') {
                  {{ opt.profile }}
                } @else {
                  {{ ('download.type_' + opt.type) | translate }}
                }
              </button>
            }
          </mat-menu>
        } @else {
          <button mat-button class="!min-w-11 !h-11 !px-2" (click)="download(p.path)" [disabled]="downloading()" [matTooltip]="I18N.photo_detail.download | translate"
            [attr.aria-label]="(downloading() ? I18N.photo_detail.downloading : I18N.photo_detail.download) | translate">
            @if (downloading()) { <mat-spinner diameter="18" class="!inline-block" aria-hidden="true" /> } @else { <mat-icon class="!m-0 @min-[960px]:!mr-2">download</mat-icon> }
            <span class="hidden @min-[960px]:inline">{{ I18N.photo_detail.download | translate }}</span>
          </button>
        }

        @if (socialExportEnabled()) {
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 max-md:!hidden" [matMenuTriggerFor]="socialMenu" [disabled]="downloading()"
            [matTooltip]="(socialCropTooltipKey() | translate)" [attr.aria-label]="I18N.photo_detail.social_crop | translate">
            <mat-icon>crop</mat-icon>
          </button>
        }

        <!-- Declared outside their @if so both the inline buttons and the overflow menu can target them. -->
        <mat-menu #similarMenu="matMenu">
          <button mat-menu-item (click)="openSimilar(p, 'visual')">
            <mat-icon>image_search</mat-icon> {{ I18N.similar.mode_visual | translate }}
          </button>
          <button mat-menu-item (click)="openSimilar(p, 'color')">
            <mat-icon>palette</mat-icon> {{ I18N.similar.mode_color | translate }}
          </button>
          <button mat-menu-item (click)="openSimilar(p, 'person')">
            <mat-icon>person_search</mat-icon> {{ I18N.similar.mode_person | translate }}
          </button>
        </mat-menu>
        <mat-menu #categoryOverrideMenu="matMenu">
          <button mat-menu-item (click)="openCategoryOverride(p)">
            <mat-icon>edit</mat-icon> {{ I18N.photo.category_override.set_action | translate }}
          </button>
          <button mat-menu-item (click)="clearCategoryOverride(p)">
            <mat-icon>restart_alt</mat-icon> {{ I18N.photo.category_override.clear_action | translate }}
          </button>
        </mat-menu>
        <mat-menu #socialMenu="matMenu">
          @for (preset of socialPresets(); track preset.key) {
            <button mat-menu-item (click)="downloadSocialCrop(p.path, preset.key)">
              <mat-icon>crop</mat-icon>
              {{ preset.label_key | translate }}
            </button>
          }
        </mat-menu>

        <!-- Below md the secondary actions fold into this menu so the filename keeps its room;
             back, critique and download stay in the row. Same handlers and conditions as the inline buttons. -->
          <button mat-icon-button class="max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 md:!hidden" [matMenuTriggerFor]="moreActionsMenu"
            [matTooltip]="I18N.nav.more | translate" [attr.aria-label]="I18N.nav.more | translate">
            <mat-icon>more_vert</mat-icon>
          </button>
          <mat-menu #moreActionsMenu="matMenu">
            <button mat-menu-item data-photo-face-menu (click)="cycleFaceBoxMode()"><mat-icon>{{ faceBoxModeIcon() }}</mat-icon>{{ faceBoxModeLabel() | translate }}</button>
            @if (auth.isEdition()) {
              <button mat-menu-item (click)="refreshPhoto(p)"><mat-icon>refresh</mat-icon> {{ I18N.photo_refresh.title | translate }}</button>
            }
            @if (store.config()?.features?.show_similar_button) {
              <button mat-menu-item [matMenuTriggerFor]="similarMenu"><mat-icon>image_search</mat-icon> {{ I18N.similar.find_similar | translate }}</button>
            }
            @if (auth.isEdition() && p.is_rejected && !p.is_kept && store.config()?.cull?.trash_available) {
              <button mat-menu-item class="!text-[var(--mat-sys-error)]" (click)="deletePhoto()"><mat-icon>delete</mat-icon> {{ I18N.photo_detail.delete.button_label | translate }}</button>
            }
            @if (auth.isEdition()) {
              <button mat-menu-item [matMenuTriggerFor]="categoryOverrideMenu"><mat-icon>category</mat-icon> {{ I18N.photo.category_override.menu_tooltip | translate }}</button>
              <button mat-menu-item (click)="openManualFaces(p)"><mat-icon>highlight_alt</mat-icon> {{ I18N.manual_faces.title | translate }}</button>
            }
            @if (auth.isEdition() && p.unassigned_faces > 0) {
              <button mat-menu-item (click)="openAddPerson(p)"><mat-icon>person_add</mat-icon> {{ I18N.manage_persons.assign_face | translate }}</button>
            }
            @if (socialExportEnabled()) {
              <button mat-menu-item [matMenuTriggerFor]="socialMenu" [disabled]="downloading()"><mat-icon>crop</mat-icon> {{ I18N.photo_detail.social_crop | translate }}</button>
            }
          </mat-menu>
      </div>

      <app-stack-navigator [path]="p.path" [allowedPaths]="store.pinnedPaths()" [stacked]="!!p.stack_id"
        (memberOpened)="openSetMember($event)" />

      <!-- Main content: the image, the rail that picks one panel, and that panel -->
      <div class="flex flex-col lg:flex-row lg:flex-1 lg:min-h-0 lg:overflow-hidden">
        <!-- Image panel -->
        <div class="flex min-h-40 max-h-[62dvh] min-w-0 shrink-0 flex-col lg:max-h-none lg:min-h-0 lg:flex-1">
        <div data-photo-canvas tabindex="0" role="group" [attr.aria-label]="I18N.photo_detail.inspection.title | translate" aria-describedby="photo-inspection-help" [appZoomPan]="p.path" #zoom="zoomPan" [style.aspect-ratio]="photoAspect()" class="group/photo focus-visible:!outline-2 focus-visible:!-outline-offset-4 focus-visible:!outline-white flex flex-auto min-h-0 items-center justify-center bg-[var(--facet-image-canvas)] relative overflow-hidden cursor-grab lg:!aspect-auto lg:flex-1">
          @for (imagePhoto of [p]; track imagePhoto.path) {
          <!-- The collection already loads this thumbnail; keep it underneath
               the larger renditions so a cold image request doesn't flash black. -->
          <img
            [src]="p.path | thumbnailUrl:240:p.preview_revision"
            [alt]="p.filename"
            class="w-full h-full max-w-full max-h-full object-contain pointer-events-none select-none"
            [style.transform]="zoom.transform()"
          />
          <img
            [src]="thumbnailImageUrl()"
            alt="" aria-hidden="true"
            class="absolute inset-0 w-full h-full object-contain transition-opacity duration-300 pointer-events-none select-none"
            [class.opacity-0]="fullImageLoaded()"
            [style.transform]="zoom.transform()"
            (load)="onThumbnailState($event)" (error)="onThumbnailState($event, true)"
          />
          <img
            [src]="fullImageUrl()"
            alt="" aria-hidden="true"
            class="absolute inset-0 w-full h-full object-contain transition-opacity duration-300 pointer-events-none select-none"
            [class.opacity-0]="!fullImageLoaded()"
            (load)="onFullImageLoad($event)" (error)="onFullImageError($event)"
            [style.transform]="zoom.transform()"
          />
          }
          <p id="photo-inspection-help" class="pointer-events-none absolute top-2 left-2 right-2 z-40 m-0 rounded bg-black/75 px-3 py-2 text-center text-xs text-white invisible group-focus-visible/photo:visible">{{ I18N.photo_detail.inspection.help | translate }}</p>
          @if (collectionNavigation().visible) {
            <div role="group" [attr.aria-label]="I18N.photo_detail.collection.title | translate" class="pointer-events-none absolute inset-0 z-30 flex items-center justify-between px-2 opacity-0 transition-opacity group-hover/photo:opacity-100 focus-within:opacity-100 max-xl:opacity-100">
              <button type="button" data-photo-previous class="pointer-events-auto inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-white disabled:invisible"
                [disabled]="!collectionNavigation().previous || store.loading()" [attr.aria-label]="I18N.photo_detail.collection.previous | translate"
                (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (click)="stepCollectionPhoto(-1); $event.stopPropagation()"><mat-icon aria-hidden="true">chevron_left</mat-icon></button>
              <span data-collection-position [attr.title]="I18N.photo_detail.collection.title | translate" class="absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-3 py-1 text-xs tabular-nums text-white">{{ I18N.photo_detail.collection.position | translate:{ position: collectionNavigation().position, total: store.total() } }}</span>
              <button type="button" data-photo-next class="pointer-events-auto inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-white disabled:invisible"
                [disabled]="!collectionNavigation().next || store.loading()" [attr.aria-label]="I18N.photo_detail.collection.next | translate"
                (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()" (click)="stepCollectionPhoto(1); $event.stopPropagation()"><mat-icon aria-hidden="true">chevron_right</mat-icon></button>
            </div>
          }
          <app-photo-face-layer
            [path]="p.path"
            [imageWidth]="p.image_width"
            [imageHeight]="p.image_height"
            [transform]="zoom.transform()"
            [canEdit]="auth.isEdition()"
            [mode]="faceBoxMode()"
            [focusPersonIds]="focusPersonIds()"
            (changed)="refreshPeople(p.path)" />
          <app-person-face-menu [path]="p.path" [canEdit]="auth.isEdition()" (changed)="onPersonMenuChanged(p.path)" />
          <app-photo-object-layer
            [path]="p.path"
            [imageWidth]="p.image_width"
            [imageHeight]="p.image_height"
            [transform]="zoom.transform()"
            [revision]="objectsRevision()" />
          <app-photo-annotation-layer [transform]="zoom.transform()" />
          <!-- The image keeps the whole panel: the rendition shows only while it is not ready yet or failed,
               and the zoom controls sit on the image like the collection arrows. -->
          @if (renditionNotice()) {
            <div data-rendition-status class="absolute bottom-2 left-2 z-30 max-w-[calc(100%-1rem)] rounded bg-black/70 px-2 py-1 text-white cursor-auto"
              (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()">
              <app-rendition-readout [state]="displayedRendition()" [pending]="sourceRendition().phase === 'loading'" [attemptFailed]="sourceRendition().phase === 'failed'" [failureLabel]="I18N.photo_detail.rendition.source_failed" (retry)="retryFullImage()" />
            </div>
          }
          <div data-zoom-controls role="group" [attr.aria-label]="I18N.photo_detail.zoom_controls | translate"
            class="absolute bottom-2 right-2 z-30 flex items-center rounded-full bg-black/60 text-xs text-white cursor-auto opacity-0 transition-opacity group-hover/photo:opacity-100 focus-within:opacity-100 max-xl:opacity-100 pointer-coarse:opacity-100"
            (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()">
            <button type="button" data-zoom-out class="min-h-9 min-w-9 max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 cursor-pointer rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40" [disabled]="zoom.scale() <= 1" [attr.aria-label]="I18N.gallery.compare.rendition.zoom_out | translate" (click)="zoom.zoomStep(-1)">−</button>
            <button type="button" data-zoom-fit class="min-h-9 min-w-9 max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 cursor-pointer rounded-full px-1 tabular-nums hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white" [attr.aria-label]="(I18N.gallery.compare.rendition.fit | translate) + (zoom.scale() === 1 ? '' : ' (' + (zoom.scale() | fixed:1) + '×)')" (click)="zoom.reset()">@if (zoom.scale() === 1) { {{ I18N.gallery.compare.rendition.fit_short | translate }} } @else { {{ zoom.scale() | fixed:1 }}× }</button>
            <button type="button" data-zoom-in class="min-h-9 min-w-9 max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 cursor-pointer rounded-full hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-40" [disabled]="zoom.scale() >= zoom.maximumScale" [attr.aria-label]="I18N.gallery.compare.rendition.zoom_in | translate" (click)="zoom.zoomStep(1)">+</button>
          </div>
        </div>
        </div>

        <!-- The rail picks one panel: Grade, Camera, Content, Filter, or an add-on. An add-on's frame stays in the shell's
             dock at the far right (moving a frame reloads it), so the panel slot is always the far-right column. -->
        <app-panel-rail data-photo-rail [rail]="rail" [tabs]="facetRailTabs" [label]="I18N.photo_detail.rail.label | translate" idPrefix="photo" />

        <!-- Drag or arrow-key the panel's left edge to trade image room for detail (lg+, remembered). -->
        <app-panel-resize-handle data-inspector-resize [panel]="inspectorWidth" [label]="I18N.photo_detail.inspector_resize | translate"
          [class.lg:!hidden]="rail.addonActive() || !rail.shownPage()" class="relative hidden lg:flex -mx-1.5" />

        <!-- Info panel -->
        <aside data-photo-inspector [attr.aria-label]="I18N.photo_detail.details | translate" [style.--facet-inspector-width]="inspectorWidth.width() + 'px'" [class.lg:!hidden]="rail.addonActive()" [class.!hidden]="!rail.shownPage()" [class.lg:flex]="rail.shownPage() === 'filter'" (keydown)="closePanels($event)" class="relative [overflow-wrap:anywhere] lg:flex-col lg:w-[var(--facet-inspector-width)] lg:shrink-0 lg:overflow-y-auto lg:border-l border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-lowest)] p-4 space-y-4 text-sm text-[var(--mat-sys-on-surface)]">
          <ng-template #categoryExplanation>
              <mat-form-field class="w-full" subscriptSizing="dynamic">
                <mat-label>{{ I18N.photo.category_override.target_category_label | translate }}</mat-label>
                <mat-select [value]="explainerTargetCategory()" (selectionChange)="explainerTargetCategory.set($event.value)">
                  @for (name of explainerCategories(); track name) {
                    <mat-option [value]="name">{{ name | categoryLabel }}</mat-option>
                  }
                </mat-select>
                @if (explainerLoadFailed()) {
                  <p role="alert" class="mt-1 text-xs text-[var(--mat-sys-on-error-container)]">
                    {{ I18N.errors.server_error | translate }}
                    <button type="button" class="underline" (click)="loadExplainerCategories()">{{ I18N.gallery.load_error.retry | translate }}</button>
                  </p>
                }
                <mat-hint>{{ I18N.photo.category_override.target_category_hint | translate }}</mat-hint>
              </mat-form-field>
              @if (explainerTargetCategory(); as target) {
                <app-category-explainer [path]="p.path" [targetCategory]="target" />
              }
          </ng-template>
          <!-- The open panel's name and the X that folds every panel (and an add-on's) to the side. -->
          <div data-panel-header class="-mb-2 flex items-center gap-2">
            <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-medium">{{ shownPanelLabel() | translate }}</h2>
            <!-- Previous / next in the collection on every panel (#386); Showing carries its own beside the list. -->
            @if (collectionNavigation().visible && rail.shownPage() !== 'filter') {
              <div data-panel-collection-nav role="group" [attr.aria-label]="I18N.photo_detail.collection.title | translate" class="flex shrink-0 items-center">
                <button mat-icon-button data-panel-previous class="!h-8 !w-8 !p-0 max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" [disabled]="!collectionNavigation().previous || store.loading()"
                  [attr.aria-label]="I18N.photo_detail.collection.previous | translate" (click)="stepCollectionPhoto(-1)"><mat-icon>chevron_left</mat-icon></button>
                <span data-panel-position class="text-xs tabular-nums">{{ I18N.photo_detail.collection.position | translate:{ position: collectionNavigation().position, total: store.total() } }}</span>
                <button mat-icon-button data-panel-next class="!h-8 !w-8 !p-0 max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" [disabled]="!collectionNavigation().next || store.loading()"
                  [attr.aria-label]="I18N.photo_detail.collection.next | translate" (click)="stepCollectionPhoto(1)"><mat-icon>chevron_right</mat-icon></button>
              </div>
            }
            <button mat-icon-button data-close-panels class="!h-8 !w-8 !p-0 max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11 shrink-0"
              [matTooltip]="I18N.ui.buttons.close_panels | translate" [attr.aria-label]="I18N.ui.buttons.close_panels | translate" (click)="rail.closeAll()">
              <mat-icon class="!text-xl">close</mat-icon>
            </button>
          </div>
          <!-- Grade, "do I keep it": the decision first, then the scores that inform it, then the set to compare with. -->
          <section id="photo-panel-grade" data-photo-panel="grade" role="tabpanel" aria-labelledby="photo-rail-grade" [hidden]="rail.shownPage() !== 'grade'" class="space-y-4">
            <!-- Account review controls. From lg up the strip sticks flush to the panel's top edge (-top-4 = the
                 panel's p-4). It starts below the panel header (mt-2 cancels the header's -mb-2), never over it: pulled
                 up over the header it hid the lower half of the title, previous / next and the X, and took their
                 clicks (B52). pt-1 keeps the Favorite button's 48 px touch target inside the strip. -->
            @if (canReview()) {
              <section data-photo-review aria-labelledby="photo-review-title" class="space-y-1 bg-[var(--mat-sys-surface-container-lowest)] lg:sticky lg:-top-4 lg:z-10 lg:-mx-4 lg:mt-2 lg:px-4 lg:pt-1 lg:pb-2">
                <h2 id="photo-review-title" class="sr-only">{{ I18N.gallery.sidebar.tabs.review | translate }}</h2>
                <!-- Like the gallery rail: no title or rule above the review controls, the favourite beside the stars. -->
                <div data-photo-rating-row class="flex items-center gap-2">
                  <div role="group" [attr.aria-label]="I18N.photo_detail.rating | translate" class="flex min-w-0 flex-1 flex-nowrap">
                    @for (star of stars; track star) {
                      <button type="button" class="min-w-9 max-w-11 flex-1 max-sm:min-w-11 pointer-coarse:min-w-11 min-h-11 rounded inline-flex items-center justify-center hover:bg-[var(--mat-sys-surface-container-high)] cursor-pointer"
                              [attr.aria-label]="(I18N.rating.set_rating | translate) + ': ' + star" [attr.aria-pressed]="p.star_rating === star" (click)="setRating(p.path, star)">
                        <mat-icon class="!text-xl !w-5 !h-5 !leading-5 !text-[var(--mat-sys-primary)]">{{ p.star_rating !== null && star <= p.star_rating! ? 'star' : 'star_border' }}</mat-icon>
                      </button>
                    }
                  </div>
                  <button mat-icon-button class="ml-auto max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" (click)="toggleFavorite(p.path)"
                    [matTooltip]="(p.is_favorite ? I18N.rating.remove_favorite : I18N.rating.add_favorite) | translate"
                    [attr.aria-label]="I18N.rating.favorite | translate" [attr.aria-pressed]="!!p.is_favorite">
                    <mat-icon class="!text-[var(--facet-favorite)]">{{ p.is_favorite ? 'favorite' : 'favorite_border' }}</mat-icon>
                  </button>
                </div>
                <div data-photo-decisions role="group" [attr.aria-label]="I18N.gallery.sidebar.review.decision | translate" class="flex items-stretch divide-x divide-[var(--mat-sys-outline-variant)] overflow-hidden rounded border border-[var(--mat-sys-outline-variant)]">
                  @if (canDecide()) {
                    <button type="button" data-photo-keep class="inline-flex min-h-11 min-w-0 flex-1 cursor-pointer focus-visible:!outline-2 focus-visible:!-outline-offset-4 focus-visible:!outline-current items-center justify-center gap-1 px-1 text-xs hover:bg-[var(--mat-sys-surface-container-high)]" [class.!bg-[var(--facet-review-kept)]]="p.is_kept" [class.!text-[var(--facet-review-on-kept)]]="p.is_kept"
                      (click)="reviewPhoto(p.is_kept ? 'undecided' : 'kept')" [attr.aria-pressed]="!!p.is_kept">
                      <mat-icon aria-hidden="true" class="!w-5 !h-5 !text-xl">{{ p.is_kept ? 'flag' : 'outlined_flag' }}</mat-icon>{{ I18N.review.keep | translate }}
                    </button>
                    <button type="button" data-photo-undecided class="inline-flex min-h-11 min-w-0 flex-1 cursor-pointer focus-visible:!outline-2 focus-visible:!-outline-offset-4 focus-visible:!outline-current items-center justify-center px-1 text-xs hover:bg-[var(--mat-sys-surface-container-high)]" [class.!bg-[var(--mat-sys-secondary-container)]]="!p.is_kept && !p.is_rejected" [class.!text-[var(--mat-sys-on-secondary-container)]]="!p.is_kept && !p.is_rejected"
                      (click)="reviewPhoto('undecided')" [attr.aria-pressed]="!p.is_kept && !p.is_rejected">
                      <span class="min-w-0 break-words hyphens-auto">{{ I18N.gallery.metadata.undecided | translate }}</span>
                    </button>
                  }
                  <button type="button" data-photo-reject class="inline-flex min-h-11 min-w-0 flex-1 cursor-pointer focus-visible:!outline-2 focus-visible:!-outline-offset-4 focus-visible:!outline-current items-center justify-center gap-1 px-1 text-xs hover:bg-[var(--mat-sys-surface-container-high)]" [class.!bg-[var(--mat-sys-error-container)]]="p.is_rejected" [class.!text-[var(--mat-sys-on-error-container)]]="p.is_rejected"
                    (click)="toggleRejected(p.path)" [attr.aria-pressed]="!!p.is_rejected">
                    <mat-icon aria-hidden="true" class="!w-5 !h-5 !text-xl">{{ p.is_rejected ? 'thumb_down' : 'thumb_down_off_alt' }}</mat-icon>{{ I18N.gallery.selection.reject | translate }}
                  </button>
                </div>
              </section>
            }

            <!-- A better shot in its group changes the decision, so it sits with it. -->
            @if (keeperHint()?.has_better) {
              <p data-photo-better-shot class="m-0 inline-flex items-center gap-1 px-2 py-0.5 bg-black/60 text-amber-300 rounded-full text-xs font-medium">
                <mat-icon class="!text-sm !w-4 !h-4 !leading-4" aria-hidden="true">arrow_circle_up</mat-icon>
                {{ I18N.culling.reason.better_shot | translate }}
              </p>
            }

            <!-- The scores to judge by: the AI score line, Quality and Composition. "Why this score?" opens the critique. -->
            <app-photo-metrics-tabs panel="grade" [sections]="GRADE_METRICS" [photo]="p" [ranges]="store.metricRangesByColumn()"
                                    [populated]="store.config()?.populated_scores"
                                    [histogramHeight]="HISTOGRAM_PANEL_HEIGHT"
                                    [histogramDefaultMode]="histogramDefaultMode()"
                                    [indicatorPercent]="clippingIndicatorPercent()"
                                    [explainable]="!!store.config()?.features?.show_critique" (explain)="openCritique(p)" />

            <!-- Set section (bracket/panorama/hdr_panorama/burst/duplicate) -->
            @if (photoSet(); as set) {
              @if (set.kind) {
                <div data-photo-set class="pt-1">
                  <div class="flex items-center gap-2 flex-wrap mb-2 text-sm">
                    <mat-icon class="!text-base !w-4 !h-4 !leading-4 opacity-70">{{ set.kind | photoSetKindIcon }}</mat-icon>
                    <span class="font-medium">{{ set.kind | photoSetKindLabel | translate }}</span>
                    <span data-set-file-count class="text-xs text-[var(--mat-sys-on-surface-variant)]" [matTooltip]="I18N.photo_detail.set.count_help | translate">{{ (set.count === 1 ? I18N.photo_detail.set.files_count : I18N.photo_detail.set.files_count_plural) | translate:{ count: set.count } }}</span>
                    @if (setBlinkCount(); as blinks) {
                      <span class="text-xs text-[var(--mat-sys-on-surface-variant)]">· {{ I18N.gallery.hidden_banner.reason_blinks | translate:{ n: blinks } }}</span>
                    }
                    @if (set.ev_span !== null) {
                      <span class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.photo_detail.set.ev_span | translate }}: {{ set.ev_span | fixed:1 }} EV</span>
                    }
                    <button mat-icon-button class="!w-7 !h-7 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !p-0 !inline-flex !items-center !justify-center ml-auto" (click)="openSetInGallery()"
                            [matTooltip]="I18N.photo_detail.set.open_in_gallery | translate" [attr.aria-label]="I18N.photo_detail.set.open_in_gallery | translate">
                      <mat-icon class="!text-base !w-4 !h-4 !leading-4">photo_library</mat-icon>
                    </button>
                  </div>
                  <div data-photo-set-strip class="grid grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-2 lg:grid-cols-5">
                    @for (member of setStripMembers(); track member.path) {
                      <button class="relative rounded-lg overflow-hidden aspect-square w-full min-w-0 cursor-pointer hover:opacity-80 transition-opacity ring-[var(--mat-sys-primary)]"
                              [class.ring-2]="member.path === p.path"
                              [attr.aria-label]="(I18N.photo_detail.set.member_position | translate:{ position: $index + 1, count: set.members.length }) + (member.ev_offset !== null ? ', ' + (member.ev_offset | evOffset) : '') + (member.ai_edit_of ? ', ' + (I18N.photo_detail.ai_edit.badge | translate) : '') + (member.is_blink ? ', ' + (I18N.ui.badges.blink | translate) : '')"
                              (click)="openSetMember(member.path)">
                        <img [src]="member.path | thumbnailUrl:96:member.preview_revision" alt="" class="w-full h-full object-cover" />
                        @if (member.ev_offset !== null) {
                          <span class="absolute bottom-0 inset-x-0 text-center text-[0.625rem] leading-4 bg-black/60 text-white">{{ member.ev_offset | evOffset }}</span>
                        } @else if (member.ai_edit_of) {
                          <span class="absolute bottom-0 inset-x-0 text-center text-[0.625rem] leading-4 font-bold bg-black/70 text-white" data-ai-label>✨ {{ I18N.photo_detail.ai_edit.badge_short | translate }}</span>
                        }
                        @if (member.is_blink) {
                          <span class="absolute top-0 inset-x-0 text-center text-[0.625rem] leading-4 font-bold bg-yellow-600 text-white">{{ I18N.ui.badges.blink | translate }}</span>
                        }
                      </button>
                    }
                  </div>
                </div>
              }
            }
          </section>
          <!-- Camera, "how was it shot": EXIF (the capture settings, once, at the panel's text size), Technical and the histogram with its clipping. -->
          <section id="photo-panel-camera" data-photo-panel="camera" role="tabpanel" aria-labelledby="photo-rail-camera" [hidden]="rail.shownPage() !== 'camera'" class="space-y-4">
            <app-photo-metrics-tabs panel="camera" class="text-xs" [sections]="CAMERA_METRICS" [assessment]="false" [dimensionsHelp]="true" [photo]="p" [ranges]="store.metricRangesByColumn()"
                                    [populated]="store.config()?.populated_scores"
                                    [histogramHeight]="HISTOGRAM_PANEL_HEIGHT"
                                    [histogramDefaultMode]="histogramDefaultMode()"
                                    [indicatorPercent]="clippingIndicatorPercent()" />
          </section>
          <!-- Content: the photo's own facts, most used first; location and file details folded at the bottom. -->
          <section id="photo-panel-content" data-photo-panel="content" role="tabpanel" aria-labelledby="photo-rail-content" [hidden]="rail.shownPage() !== 'content'" class="space-y-4">
            <!-- Capture date and scoring category on one line -->
            <div data-photo-when class="space-y-1 text-xs text-[var(--mat-sys-on-surface-variant)]">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                @if (p.date_taken || auth.isEdition()) {
                  <span data-photo-date class="inline-flex items-center gap-1">
                    @if (auth.isEdition()) {
                      <button mat-icon-button class="!w-7 !h-7 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !min-w-0 !p-0 -ml-1.5 !inline-flex items-center justify-center" (click)="editCaptureDate(p)"
                              [matTooltip]="I18N.capture_date.title | translate"
                              [attr.aria-label]="I18N.capture_date.title | translate">
                        <mat-icon class="!text-base !w-4 !h-4 !leading-4">edit_calendar</mat-icon>
                      </button>
                    }
                    @if (p.date_taken) { <span class="leading-4">{{ p.date_taken | captureDate: locale() }}</span> }
                    @else { <span>{{ I18N.gallery.no_capture_date | translate }}</span> }
                  </span>
                }
                @if (p.category || auth.isEdition()) {
                  <span data-photo-category class="inline-flex items-center gap-1">
                    {{ p.category ? (p.category | categoryLabel) : (I18N.category_names.default | translate) }}
                    <!-- Category explainer toggle: "why isn't this photo classified as X?" — kept for an uncategorized photo too. -->
                    @if (auth.isEdition()) {
                      <app-control-popover icon="help_outline" [compact]="true" [label]="I18N.photo.category_override.explainer_toggle | translate" [content]="categoryExplanation" (opened)="loadExplainerCategories()" />
                    }
                  </span>
                }
              </div>
            </div>

            <!-- Describe: caption, tags and people; an editor adds a missing one from the compact actions -->
            <div #describe data-photo-describe class="space-y-3">
              @if (displayCaption() || translatingCaption()) {
                <div data-photo-caption>
                  <div class="flex items-center justify-between mb-1">
                    <div class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.photo_detail.caption | translate }}</div>
                    @if (auth.isEdition()) {
                      <button mat-icon-button class="!w-7 !h-7 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !p-0" (click)="editCaption(p)" [matTooltip]="I18N.photo_detail.edit_caption | translate" [attr.aria-label]="I18N.photo_detail.edit_caption | translate">
                        <mat-icon class="!text-base !w-4 !h-4 !leading-4">edit</mat-icon>
                      </button>
                    }
                  </div>
                  @if (translatingCaption()) {
                    <p class="text-[var(--mat-sys-on-surface-variant)] italic text-xs">{{ I18N.photo_detail.translating_caption | translate }}</p>
                  } @else {
                    <p class="text-[var(--mat-sys-on-surface-variant)]">{{ displayCaption() }}</p>
                  }
                </div>
              }

              <!-- A manual tag's chip (marked, removable for editors) and the tag menu, shared by Tags, Object tags and Album tags. -->
              <ng-template #manualTagChip let-tag>
                <span data-testid="manual-tag-chip"
                      class="inline-flex min-w-0 max-w-full items-center rounded-full border border-dashed border-[var(--facet-accent-text)] text-[var(--facet-accent-text)] text-xs">
                  <button class="inline-flex items-center min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 max-sm:min-w-11 pointer-coarse:min-w-11 min-w-0 gap-1 pl-2 pr-2 py-0.5 cursor-pointer hover:opacity-80 transition-opacity"
                          [attr.title]="I18N.manual_tags.manual | translate"
                          [matMenuTriggerFor]="tagNavigationMenu" [matMenuTriggerData]="{ tag: tag }">
                    <mat-icon class="!text-xs !w-3 !h-3 !leading-3" aria-hidden="true">sell</mat-icon>
                    <span class="sr-only">{{ I18N.manual_tags.manual | translate }}:</span>
                    <span class="min-w-0 [overflow-wrap:anywhere] text-left">{{ tag }}</span>
                  </button>
                  @if (auth.isEdition()) {
                    <button data-testid="manual-tag-remove"
                            class="inline-flex items-center justify-center shrink-0 min-w-6 min-h-6 max-sm:min-w-11 max-sm:min-h-11 pointer-coarse:min-w-11 pointer-coarse:min-h-11 -ml-1 max-sm:ml-0 pointer-coarse:ml-0 cursor-pointer hover:opacity-80"
                            [attr.aria-label]="I18N.manual_tags.remove_tag | translate:{ tag: tag }"
                            (click)="removeManualTag(p, tag)">
                      <mat-icon class="!text-xs !w-3 !h-3 !leading-3" aria-hidden="true">close</mat-icon>
                    </button>
                  }
                </span>
              </ng-template>
              <mat-menu #tagNavigationMenu="matMenu">
                <ng-template matMenuContent let-tag="tag">
                  @if (tagCollectionAvailable()) {
                    <button mat-menu-item (click)="navigateTag(tag, 'collection')"><mat-icon>filter_alt</mat-icon>{{ I18N.photo_detail.tag_refine_collection | translate }}</button>
                  }
                  <button mat-menu-item (click)="navigateTag(tag, 'library')"><mat-icon>search</mat-icon>{{ I18N.photo_detail.tag_search_library | translate }}</button>
                </ng-template>
              </mat-menu>

              <!-- Tags: what the photo shows. AI chips, then the user's own (dashed), then + Tag. -->
              @if (p.tags_list.length || tagGroups().own.length || tagInputOpen()) {
                <div data-testid="tags-section">
                  <div class="text-xs text-[var(--mat-sys-on-surface-variant)] mb-2">{{ I18N.photo_detail.tags | translate }}</div>
                  <div data-tag-group="tags" class="flex gap-1.5 flex-wrap items-center">
                    @for (tag of p.tags_list; track tag) {
                      <span data-testid="ai-tag-chip" class="inline-flex min-w-0 max-w-full">
                        <button class="inline-flex items-center min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 max-sm:min-w-11 pointer-coarse:min-w-11 max-w-full [overflow-wrap:anywhere] text-left px-2 py-0.5 bg-[var(--facet-accent-badge)] text-[var(--facet-accent-text)] rounded-full text-xs cursor-pointer hover:opacity-80 transition-opacity"
                                [matMenuTriggerFor]="tagNavigationMenu" [matMenuTriggerData]="{ tag: tag }">{{ tag }}</button>
                      </span>
                    }
                    @for (tag of tagGroups().own; track tag) {
                      <ng-container [ngTemplateOutlet]="manualTagChip" [ngTemplateOutletContext]="{ $implicit: tag }" />
                    }
                    @if (auth.isEdition() && !tagInputOpen()) {
                      <button type="button" data-add-tag class="inline-flex min-h-6 items-center gap-0.5 rounded-full border border-dashed border-[var(--mat-sys-outline)] px-2 py-0.5 text-xs text-[var(--mat-sys-on-surface-variant)] cursor-pointer hover:bg-[var(--mat-sys-surface-container-high)] max-sm:min-h-11 pointer-coarse:min-h-11"
                              [attr.aria-label]="I18N.manual_tags.add | translate" (click)="openTagInput()">
                        <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">add</mat-icon>{{ I18N.manual_tags.tag_label | translate }}
                      </button>
                    }
                  </div>
                  @if (auth.isEdition() && tagInputOpen()) {
                    <div class="flex items-center gap-1 mt-2" data-testid="manual-tag-add">
                      <input type="text" maxlength="64"
                             class="min-w-0 flex-1 max-sm:min-h-11 pointer-coarse:min-h-11 px-2 py-1 text-xs rounded border border-[var(--mat-sys-outline-variant)] bg-transparent"
                             [value]="newTag()"
                             [attr.aria-label]="I18N.manual_tags.add | translate"
                             [placeholder]="I18N.manual_tags.add | translate"
                             (input)="onNewTagInput($event)"
                             (keydown.enter)="addManualTag(p, newTag())" (keydown.escape)="closeTagInput($event)" />
                      <button mat-icon-button class="!w-7 !h-7 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !p-0 !inline-flex !items-center !justify-center shrink-0" (click)="addManualTag(p, newTag())"
                              [disabled]="!newTag().trim()"
                              [matTooltip]="I18N.manual_tags.add | translate" [attr.aria-label]="I18N.manual_tags.add | translate">
                        <mat-icon class="!text-base !w-4 !h-4 !leading-4">add</mat-icon>
                      </button>
                    </div>
                  }
                </div>
              }

              <!-- People tags: who is in it. -->
              @if (p.persons.length || p.unassigned_faces) {
                <section data-photo-people aria-labelledby="photo-people-title">
                  <h2 id="photo-people-title" class="m-0 mb-1 text-xs font-normal text-[var(--mat-sys-on-surface-variant)]">{{ I18N.photo_detail.people_tags | translate }}</h2>
                  @if (p.unassigned_faces) { <p class="m-0 pb-2 text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.photo_detail.unassigned_faces | translate:{ count: p.unassigned_faces } }}</p> }
                  <div class="flex gap-3 flex-wrap">
                    @for (person of p.persons; track person.id) {
                      <button class="flex min-w-0 max-w-full flex-col items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity"
                              data-person-avatar aria-haspopup="menu"
                              (click)="openPersonMenu(person, $event)">
                        <img
                          [src]="person.id | personThumbnailUrl"
                          [alt]="person.name"
                          class="w-10 h-10 rounded-full object-cover bg-[var(--mat-sys-surface-container)]"
                        />
                        <span class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{ person.name }}</span>
                      </button>
                    }
                  </div>
                </section>
              }

              <!-- Object tags: what an add-on found, one folded row per add-on, opened on demand. -->
              @if (tagGroups().addons.length) {
                <div data-object-tags class="space-y-1.5">
                  @for (group of tagGroups().addons; track group.source) {
                    <div data-object-tag-row [attr.data-source]="group.source" class="flex gap-1.5 flex-wrap items-center">
                      @if (group.tags.length) {
                        <button type="button" data-addon-tag-group [attr.data-source]="group.source" [attr.aria-expanded]="group.expanded"
                                class="inline-flex min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 items-center gap-0.5 rounded-full border border-[var(--mat-sys-outline-variant)] px-2 py-0.5 text-xs text-[var(--mat-sys-on-surface-variant)] cursor-pointer hover:bg-[var(--mat-sys-surface-container-high)]"
                                [attr.aria-label]="I18N.photo_detail.object_tags.label | translate:{ name: group.name, count: group.tags.length }" (click)="toggleTagSource(group.source)">
                          <span aria-hidden="true">{{ (group.tags.length === 1 ? I18N.photo_detail.object_tags.summary_one : I18N.photo_detail.object_tags.summary) | translate:{ name: group.name, count: group.tags.length } }}</span>
                          <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">{{ group.expanded ? 'expand_less' : 'chevron_right' }}</mat-icon>
                        </button>
                        @if (group.expanded) {
                          @for (tag of group.tags; track tag) {
                            <ng-container [ngTemplateOutlet]="manualTagChip" [ngTemplateOutletContext]="{ $implicit: tag }" />
                          }
                        }
                      }
                      <!-- Everything the add-on indexed (Model D), folded; each label opens the gallery on photos with it. -->
                      @if (group.objects) {
                        <button type="button" data-addon-objects [attr.data-source]="group.source" [attr.aria-expanded]="group.objectsExpanded"
                                class="inline-flex min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 items-center gap-0.5 rounded-full border border-[var(--mat-sys-outline-variant)] px-2 py-0.5 text-xs text-[var(--mat-sys-on-surface-variant)] cursor-pointer hover:bg-[var(--mat-sys-surface-container-high)]"
                                [attr.aria-label]="I18N.photo_detail.object_tags.indexed_label | translate:{ name: group.name, count: group.objects }" (click)="toggleDetections(group.source)">
                          <span aria-hidden="true">{{ (group.tags.length ? I18N.photo_detail.object_tags.indexed : group.objects === 1 ? I18N.photo_detail.object_tags.summary_one : I18N.photo_detail.object_tags.summary) | translate:{ name: group.name, count: group.objects } }}</span>
                          <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">{{ group.objectsExpanded ? 'expand_less' : 'chevron_right' }}</mat-icon>
                        </button>
                        @if (group.objectsExpanded) {
                          @if (group.labels === 'loading') {
                            <span role="status" class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.ui.labels.loading | translate }}</span>
                          } @else if (group.labels === 'failed') {
                            <span role="alert" class="text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.errors.action_failed | translate }}</span>
                          } @else {
                            @for (label of group.labels; track label) {
                              <button type="button" data-detection-chip [title]="I18N.photo_detail.object_tags.search | translate:{ label: label }" (click)="navigateDetection(label)"
                                      class="inline-flex min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 max-w-full items-center rounded-full bg-[var(--mat-sys-surface-container-high)] px-2 py-0.5 text-left text-xs [overflow-wrap:anywhere] cursor-pointer hover:opacity-80">{{ label }}</button>
                            }
                          }
                        }
                      }
                    </div>
                  }
                </div>
              }

              <!-- Album tags: filing, only for filtering; muted, folded, last. Each chip's menu filters by it. -->
              @if (tagGroups().album.length) {
                <div data-album-tags class="flex gap-1.5 flex-wrap items-center">
                  <button type="button" data-album-tag-group [attr.aria-expanded]="tagGroups().albumExpanded"
                          class="inline-flex min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-[var(--mat-sys-on-surface-variant)] opacity-80 cursor-pointer hover:bg-[var(--mat-sys-surface-container-high)]"
                          [attr.title]="I18N.photo_detail.album_tags.hint | translate"
                          [attr.aria-label]="I18N.photo_detail.album_tags.label | translate:{ count: tagGroups().album.length }" (click)="toggleAlbumTags()">
                    <span aria-hidden="true">{{ I18N.photo_detail.album_tags.summary | translate:{ count: tagGroups().album.length } }}</span>
                    <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-3.5" aria-hidden="true">{{ tagGroups().albumExpanded ? 'expand_less' : 'chevron_right' }}</mat-icon>
                  </button>
                  @if (tagGroups().albumExpanded) {
                    @for (tag of tagGroups().album; track tag) {
                      <button type="button" data-album-tag-chip
                              class="inline-flex min-h-6 max-sm:min-h-11 pointer-coarse:min-h-11 max-w-full items-center rounded-full border border-[var(--mat-sys-outline-variant)] px-2 py-0.5 text-left text-xs text-[var(--mat-sys-on-surface-variant)] [overflow-wrap:anywhere] cursor-pointer hover:opacity-80"
                              [matMenuTriggerFor]="tagNavigationMenu" [matMenuTriggerData]="{ tag: tag }">{{ tag }}</button>
                    }
                  }
                </div>
              }

              @if (auth.isEdition() && (!p.caption || (!p.tags_list.length && !tagGroups().own.length && !tagInputOpen()) || p.gps_latitude === null || p.gps_longitude === null)) {
                <div data-photo-add class="flex flex-wrap items-center gap-1">
                  @if (!p.caption) {
                    <button mat-stroked-button class="!h-8 !min-w-0 !px-2.5 !text-xs max-sm:!h-11 pointer-coarse:!h-11" (click)="editCaption(p)" [attr.aria-label]="I18N.photo_detail.add_caption | translate">
                      <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">add_comment</mat-icon>{{ I18N.photo_detail.caption | translate }}
                    </button>
                    @if (store.config()?.features?.show_captions) {
                      <button mat-icon-button class="!w-8 !h-8 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !p-0" (click)="generateCaption(p.path)" [disabled]="generatingCaption()" [matTooltip]="I18N.photo_detail.generate_caption | translate" [attr.aria-label]="I18N.photo_detail.generate_caption | translate">
                        @if (generatingCaption()) {
                          <mat-spinner diameter="16" [attr.aria-label]="I18N.ui.labels.loading | translate" />
                        } @else {
                          <mat-icon class="!text-base !w-4 !h-4 !leading-4">auto_fix_high</mat-icon>
                        }
                      </button>
                    }
                  }
                  @if (!p.tags_list.length && !tagGroups().own.length && !tagInputOpen()) {
                    <button mat-stroked-button data-add-tag class="!h-8 !min-w-0 !px-2.5 !text-xs max-sm:!h-11 pointer-coarse:!h-11" (click)="openTagInput()" [attr.aria-label]="I18N.manual_tags.add | translate">
                      <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">sell</mat-icon>{{ I18N.manual_tags.tag_label | translate }}
                    </button>
                  }
                  @if (p.gps_latitude === null || p.gps_longitude === null) {
                    <button mat-stroked-button class="!h-8 !min-w-0 !px-2.5 !text-xs max-sm:!h-11 pointer-coarse:!h-11" (click)="editGps(p)" [attr.aria-label]="I18N.photo_detail.add_location | translate">
                      <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">add_location</mat-icon>{{ I18N.photo_detail.location | translate }}
                    </button>
                  }
                </div>
              }
            </div>

            <!-- The albums this photo is in (upstream #521). -->
            @if (store.config()?.features?.show_albums) { <app-photo-albums [photo]="p" /> }

            <!-- Location, folded to one line near the bottom (map and exact coordinates on demand, remembered). -->
            @if (p.gps_latitude !== null && p.gps_longitude !== null) {
              <div data-photo-location>
                <div class="flex items-center gap-1">
                  <button type="button" data-location-toggle aria-controls="photo-location-detail" [attr.aria-expanded]="locationOpen()"
                          [matTooltip]="I18N.photo_detail.location_map | translate" (click)="toggleLocation()"
                          class="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded text-left text-xs text-[var(--mat-sys-on-surface-variant)] hover:bg-[var(--mat-sys-surface-container-high)] focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)] max-sm:min-h-11 pointer-coarse:min-h-11">
                    <mat-icon class="!text-base !w-4 !h-4 !leading-4 shrink-0" aria-hidden="true">place</mat-icon>
                    <span class="sr-only">{{ I18N.photo_detail.location | translate }}:</span>
                    <span data-location-summary class="min-w-0 truncate tabular-nums">{{ locationName() || (p.gps_latitude | fixed:4) + ', ' + (p.gps_longitude | fixed:4) }}</span>
                    <mat-icon class="!text-base !w-4 !h-4 !leading-4 ml-auto shrink-0" aria-hidden="true">{{ locationOpen() ? 'expand_less' : 'expand_more' }}</mat-icon>
                  </button>
                  @if (auth.isEdition()) {
                    <button mat-icon-button class="!w-7 !h-7 max-sm:!w-11 max-sm:!h-11 pointer-coarse:!w-11 pointer-coarse:!h-11 !p-0" (click)="editGps(p)" [matTooltip]="I18N.photo_detail.edit_location | translate" [attr.aria-label]="I18N.photo_detail.edit_location | translate">
                      <mat-icon class="!text-base !w-4 !h-4 !leading-4">edit_location</mat-icon>
                    </button>
                  }
                </div>
                <div id="photo-location-detail" class="mt-1 space-y-1" [hidden]="!locationOpen()">
                  <div class="text-xs tabular-nums text-[var(--mat-sys-on-surface-variant)]">{{ p.gps_latitude | fixed:6 }}, {{ p.gps_longitude | fixed:6 }}</div>
                  <!-- Light OSM tiles in both themes: the dark theme's inverted tiles lose their labels at this size. -->
                  <div #locationMapContainer data-location-map class="w-full h-40 rounded-lg overflow-hidden [&_.leaflet-tile-pane]:![filter:none]"></div>
                </div>
              </div>
            }

            <!-- File details: metadata sources and related files, one open at a time -->
            <mat-accordion data-file-details displayMode="flat" class="block">
              <app-photo-provenance [photo]="p" />
              <app-photo-related-files [photo]="p" (logicalApplied)="onLogicalAssetApplied($event)" />
            </mat-accordion>
          </section>
          <section id="photo-panel-filter" data-photo-panel="filter" role="tabpanel" aria-labelledby="photo-rail-filter" [hidden]="rail.shownPage() !== 'filter'" class="flex min-h-0 flex-col gap-3 lg:flex-1">
            <!-- Showing: the content this photo is one of. Its name and how many filters define it, where you are
                 in it, then its photos; the filters themselves fold behind their count. -->
            @if (collectionSidebarAvailable()) {
              <div data-view-collection class="min-w-0">
                <h3 class="m-0 truncate text-sm font-medium" [title]="store.currentAlbum()?.name || (I18N.gallery.all_photos | translate)">{{ store.currentAlbum()?.name || (I18N.gallery.all_photos | translate) }}</h3>
                @if (viewFilterChips().length) {
                  <button type="button" data-view-filters-toggle aria-controls="photo-view-filters" [attr.aria-expanded]="viewFiltersOpen()" (click)="viewFiltersOpen.set(!viewFiltersOpen())"
                    class="inline-flex min-h-7 cursor-pointer items-center gap-0.5 rounded p-0 text-left text-xs tabular-nums text-[var(--mat-sys-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)] max-sm:min-h-11 pointer-coarse:min-h-11">
                    {{ viewFilterChips().length | pluralKey:I18N.gallery.rail.filters_one:I18N.gallery.rail.filters | translate:{ count: viewFilterChips().length } }}
                    <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">{{ viewFiltersOpen() ? 'expand_less' : 'expand_more' }}</mat-icon>
                  </button>
                  <ul id="photo-view-filters" data-view-filters [attr.aria-label]="I18N.photo_detail.view.filters | translate" [hidden]="!viewFiltersOpen()" class="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">
                    @for (chip of viewFilterChips(); track chip.id) {
                      <li class="rounded-full border border-[var(--mat-sys-outline-variant)] px-2 py-0.5 text-xs">{{ chip.labelKey | translate }}@if (chip.value) {: {{ chip.value }}}</li>
                    }
                  </ul>
                }
              </div>
              <div class="flex items-center gap-1">
                <button mat-icon-button data-view-previous class="!h-9 !w-9 max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" [disabled]="!collectionNavigation().previous || store.loading()"
                  [attr.aria-label]="I18N.photo_detail.collection.previous | translate" (click)="stepCollectionPhoto(-1)"><mat-icon>chevron_left</mat-icon></button>
                <span data-view-position class="text-xs tabular-nums">{{ I18N.photo_detail.collection.position | translate:{ position: collectionNavigation().position, total: store.total() } }}</span>
                <button mat-icon-button data-view-next class="!h-9 !w-9 max-sm:!h-11 max-sm:!w-11 pointer-coarse:!h-11 pointer-coarse:!w-11" [disabled]="!collectionNavigation().next || store.loading()"
                  [attr.aria-label]="I18N.photo_detail.collection.next | translate" (click)="stepCollectionPhoto(1)"><mat-icon>chevron_right</mat-icon></button>
                <button mat-stroked-button data-view-open-gallery class="ml-auto !h-9 !min-w-0 !px-2.5 !text-xs max-sm:!h-11 pointer-coarse:!h-11" (click)="goBack()">
                  <mat-icon class="!text-base !w-4 !h-4 !leading-4" aria-hidden="true">grid_view</mat-icon>{{ I18N.photo_detail.view.open_gallery | translate }}
                </button>
              </div>
              <app-photo-collection-sidebar class="min-h-0 flex-1" [photos]="store.photos()" [currentPath]="collectionEntry()?.path ?? p.path"
                [total]="store.total()" [hasMore]="store.hasMore()" [loading]="store.loading()"
                (choose)="openCollectionPhoto($event)" (more)="loadCollectionPage()" (step)="stepCollection($event)" />
            } @else {
              <p data-view-standalone class="m-0 text-xs text-[var(--mat-sys-on-surface-variant)]">{{ I18N.photo_detail.view.standalone | translate }}</p>
            }
          </section>
        </aside>
      </div>
    } @else if (photoMissing()) {
      <div class="flex flex-col items-center justify-center gap-2 h-full text-[var(--mat-sys-on-surface-variant)]">
        <mat-icon class="!text-4xl">image_not_supported</mat-icon>
        {{ I18N.errors.photo_not_found | translate }}
        <button mat-button (click)="goBack()">
          <mat-icon>arrow_back</mat-icon>
          {{ I18N.photo_detail.back | translate }}
        </button>
      </div>
    } @else {
      <div class="flex items-center justify-center h-full">
        <mat-icon class="!text-4xl text-[var(--mat-sys-on-surface-variant)]">hourglass_empty</mat-icon>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'flex flex-col h-full overflow-y-auto lg:overflow-y-hidden' },
})
export class PhotoDetailComponent extends PhotoDetailBase implements OnInit {
  /** The viewer's language, the argument of the date pipes. */
  protected readonly locale = inject(I18nService).locale;
  protected readonly I18N = i18nKeys();
  protected readonly photoAspect = computed(() => {
    const photo = this.photo();
    return photo ? aspectOf(photo) : null;
  });
  private readonly location = inject(Location);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly store = inject(GalleryStore);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private readonly staleness = inject(StalenessGuardFactory);
  private readonly assistantChanges = inject(AssistantChangesService);
  private readonly photoActions = inject(PhotoActionsService);
  private readonly journal = inject(UserActivityJournal);
  /** The inspector's user-set width (lg+): the image comes first, the details panel gives way. */
  protected readonly inspectorWidth = new PanelWidth({ storageKey: 'facet_photo_inspector_width', defaultWidth: 320, min: 288, max: 520, side: 'right' });
  /** The image's rendition only needs a word while it is not ready yet or its source failed. */
  protected readonly renditionNotice = computed(() => this.displayedRendition().phase !== 'ready' || this.sourceRendition().phase !== 'ready');
  /** Add-on tag groups the user opened on this photo; every photo starts with them folded. */
  private readonly expandedTagSources = linkedSignal<string | undefined, ReadonlySet<string>>({
    source: () => this.photo()?.path, computation: () => new Set<string>(),
  });
  /**
   * The photo's tags in the four kinds (F25d): Tags (AI + own) open, People tags open, Object tags folded one row per
   * add-on, Album tags folded and last. Never mixed: an add-on's or an album's tag never shows as a Tag.
   */
  protected readonly tagGroups = computed(() => {
    const photo = this.photo();
    const fetched = this.fetchedTagSources();
    const current = fetched && fetched.path === photo?.path ? fetched : null;
    const modelD = photo as (Photo & AddonPhotoFields) | null;
    // An object tag: named by manual_tag_sources (this fork) or plugin_tags (Model D).
    const sources: Record<string, string> = { ...(photo?.manual_tag_sources ?? current?.sources ?? {}) };
    for (const { tag, source } of modelD?.plugin_tags ?? current?.pluginTags ?? []) sources[tag] = source;
    const kinds = tagKinds(photo, sources);
    const indexed = new Map<string, number>();
    for (const { source, count } of modelD?.detections ?? current?.detections ?? []) if (count > 0) indexed.set(source, count);
    const written = new Map(kinds.objects.map(group => [group.source, group.tags]));
    const names = this.addonNames();
    const expanded = this.expandedTagSources();
    const labels = this.detectionLabels();
    const addons = [...new Set([...written.keys(), ...indexed.keys()])].map(source => ({
      source, tags: written.get(source) ?? [], name: names.get(source) ?? source, expanded: expanded.has(source),
      objects: indexed.get(source) ?? 0, objectsExpanded: expanded.has(OBJECTS + source), labels: labels.get(source) ?? 'loading' as DetectionLabels,
    }));
    return { own: kinds.own, addons, album: kinds.album, albumExpanded: expanded.has(ALBUM) };
  });
  /** Only `GET /api/photo` names a tag's add-on and carries its detections; a photo opened from a gallery, album or
   *  collection row has neither, so they are read for it here (when it has manual tags, or add-ons are on). */
  private readonly fetchedTagSources = signal<{
    path: string; sources: Readonly<Record<string, string>>;
    pluginTags: AddonPhotoFields['plugin_tags']; detections: AddonPhotoFields['detections'];
  } | null>(null);
  private readonly tagSourcesPath = computed(() => {
    const photo = this.photo();
    if (!photo) return null;
    // Gallery rows name an add-on's tags now; only GET /api/photo carries Model D's detections, and an add-on can index
    // them without writing a tag, so with add-ons on a photo without them is read once.
    const unnamed = photo.manual_tag_sources == null && photo.manual_tags.length > 0;
    const noDetections = this.auth.hasFeature('addons') && (photo as Photo & AddonPhotoFields).detections === undefined;
    return unnamed || noDetections ? photo.path : null;
  });
  private readonly tagSourcesEffect = effect(() => {
    const path = this.tagSourcesPath();
    if (!path || untracked(this.fetchedTagSources)?.path === path) return;
    untracked(() => firstValueFrom(this.api.get<Photo>('/photo', { path }))
      .then(fresh => {
        if (this.photo()?.path !== path) return;
        const added = fresh as Photo & AddonPhotoFields;
        this.fetchedTagSources.set({ path, sources: fresh.manual_tag_sources ?? {}, pluginTags: added.plugin_tags, detections: added.detections });
      })
      .catch(() => undefined));
  });
  /** The right rail: Grade, Camera, Content, Filter or an add-on's panel, remembered per browser. */
  protected readonly rail: AddonRail<FacetTab> = new AddonRail<FacetTab>({
    storageKey: 'facet_photo_rail_tab', tabs: ['grade', 'camera', 'content', 'filter'], defaultTab: 'grade',
    needsRegistry: () => this.tagGroups().addons.length > 0,
  });
  protected readonly GRADE_METRICS = GRADE_METRICS;
  protected readonly CAMERA_METRICS = CAMERA_METRICS;
  protected readonly facetRailTabs = [
    { id: 'grade', icon: 'star_half', label: I18N.photo_detail.rail.grade },
    { id: 'camera', icon: 'photo_camera', label: I18N.photo_detail.rail.camera },
    { id: 'content', icon: 'info', label: I18N.photo_detail.rail.content },
    { id: 'filter', icon: 'photo_library', label: I18N.photo_detail.rail.showing },
  ] as const;
  /** The open page panel's name, for the panel header. */
  protected readonly shownPanelLabel = computed(() => this.facetRailTabs.find(tab => tab.id === this.rail.shownPage())?.label ?? '');
  private readonly railElement = viewChild<PanelRailComponent, ElementRef<HTMLElement>>(PanelRailComponent, { read: ElementRef });

  /** Escape in a panel folds every panel to the side; the focus goes back to the rail. */
  protected closePanels(event: KeyboardEvent): void {
    if (this.rail.escape(event)) this.railElement()?.nativeElement.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus();
  }
  /** Add-on id -> its name ("Astro"), for the add-on tag groups. */
  private readonly addonNames = computed<ReadonlyMap<string, string>>(() => new Map(this.rail.registry().map(addon => [addon.id, addon.name])));
  /** The filters that define the collection, as the gallery's criteria row shows them; the album is its name. */
  protected readonly viewFilterChips = computed(() => {
    if (!this.collectionSidebarAvailable()) return [];
    this.i18n.translations();
    return definingFilters(galleryFilterChips(this.store, key => this.i18n.t(key), this.i18n.locale()));
  });
  /** Showing's filter list, folded behind its count: the content comes first, its definition on demand. */
  protected readonly viewFiltersOpen = signal(false);

  /** An add-on's detection labels for the open photo, read the first time its objects chip opens. */
  private readonly detectionLabels = linkedSignal<string | undefined, ReadonlyMap<string, DetectionLabels>>({
    source: () => this.photo()?.path, computation: () => new Map(),
  });

  protected toggleDetections(source: string): void {
    this.toggleTagSource(OBJECTS + source);
    const path = this.photo()?.path;
    // Read on opening; a failed read is tried again on the next open.
    const known = this.detectionLabels().get(source);
    if (!path || !this.expandedTagSources().has(OBJECTS + source) || (known !== undefined && known !== 'failed')) return;
    const settle = (value: DetectionLabels) => {
      if (this.photo()?.path === path) this.detectionLabels.update(map => new Map(map).set(source, value));
    };
    settle('loading');
    firstValueFrom(this.api.get<{ detections: { label: string }[] }>('/photo/detections', { path, source }))
      .then(result => settle([...new Set(result.detections.map(detection => detection.label))]))
      .catch(() => settle('failed'));
  }

  /** The gallery on every photo where an add-on found this label. */
  protected navigateDetection(label: string): void {
    // As for tags: the chip must not take another viewer (a different account, a share link) into this library.
    if (!this.isCurrentViewer()) return;
    this.router.navigate(['/'], { info: GALLERY_REVISIT, queryParams: { detected: label } });
  }

  protected toggleAlbumTags(): void {
    this.toggleTagSource(ALBUM);
  }

  protected toggleTagSource(source: string): void {
    this.expandedTagSources.update(open => {
      const next = new Set(open);
      if (!next.delete(source)) next.add(source);
      return next;
    });
  }
  private readonly keymap = inject(KeyboardMappingService);
  private readonly stacks = inject(PhotoStackService);
  private readonly mapSource = inject(MapSourcePreferences);
  private readonly stackNavigator = viewChild(StackNavigatorComponent);
  private readonly faceLayer = viewChild(PhotoFaceLayerComponent);
  private readonly personMenu = viewChild(PersonFaceMenuComponent);
  private memberRequest = 0;
  private memberPhoto: { photo: Photo; owner: string } | null = null;
  private readonly viewerOwner = this.auth.identity();
  private readonly viewerSession = privateImageSessionKey();
  /** Only gallery-opened entries own an in-app Back destination. Direct links
   *  must not send Escape to an unrelated page or about:blank. */
  private readonly timelineOrigin = (this.router.currentNavigation()?.extras.state?.['photoOrigin'] ?? history.state?.['photoOrigin']) === 'timeline';
  private readonly timeline = this.timelineOrigin ? inject(TimelineFeedCache) : null;
  private openedFromGallery = this.readBackOwnership();

  private readBackOwnership(state = this.router.currentNavigation()?.extras.state ?? history.state): boolean {
    return typeof state?.['photoBack'] === 'boolean' ? state['photoBack']
      : this.timelineOrigin || state?.['photoOrigin'] === 'in-app' || !!state?.['photo'];
  }

  /** Folded stacks occupy their loaded cover's slot in the originating collection. */
  protected readonly collectionEntry = computed(() => {
    const current = this.photo();
    if (!current) return undefined;
    const photos = this.store.photos();
    // Single-photo responses do not carry gallery stack annotations. The strip's
    // authorized membership supplies the same identity after a direct member load.
    const stackId = current.stack_id ?? this.stackNavigator()?.visibleStack()?.id;
    // A set's hidden frames (a burst's non-lead shots, say) are not collection rows:
    // they stand on the loaded frame of the same set, as a folded stack's members do.
    return photos.find(photo => photo.path === current.path)
      ?? (stackId ? photos.find(photo => photo.stack_id === stackId) : undefined)
      ?? photos.find(photo => sharesSet(photo, current));
  });
  protected readonly collectionSidebarAvailable = computed(() => !this.timelineOrigin && this.viewerOwner === this.auth.identity()
    && !!this.collectionEntry());
  protected readonly collectionNavigation = computed(() => {
    const photos = this.store.photos();
    const index = photos.findIndex(photo => photo.path === this.collectionEntry()?.path);
    return {
      visible: this.collectionSidebarAvailable(),
      position: index + 1,
      previous: index > 0,
      next: index >= 0 && (index + 1 < photos.length || this.store.hasMore()),
    };
  });
  protected stepCollectionPhoto(delta: number): void {
    if (!this.collectionNavigation().visible || this.destroyRef.destroyed || this.router.currentNavigation?.() || this.dialog.openDialogs.length) return;
    void this.navigateAdjacentPhoto(delta, true);
  }
  // A later library search replaces the singleton store. Keep the query owned
  // by this history entry, including when Back recreates the photo component.
  private readonly tagOrigin = signal(this.readTagOrigin());
  protected readonly tagCollectionAvailable = computed(() => this.tagOrigin()?.refinable === true
    && this.viewerOwner === this.auth.identity());

  private readTagOrigin(
    state = this.router.currentNavigation()?.extras.state ?? history.state,
    trigger = this.router.currentNavigation()?.trigger ?? 'imperative',
  ): PhotoTagOrigin | null {
    if (this.viewerOwner !== this.auth.identity()) return null;
    if (state && Object.hasOwn(state, 'photoTagOrigin')) {
      const origin = state['photoTagOrigin'] as PhotoTagOrigin | null;
      return origin?.owner === this.viewerOwner && typeof origin.refinable === 'boolean'
        && origin.params && typeof origin.params === 'object' && !Array.isArray(origin.params)
        && Object.values(origin.params).every(value => typeof value === 'string') ? origin : null;
    }
    if (!state?.['photo'] || state?.['photoOrigin'] === 'timeline') return null;
    // An old/unowned history entry must never capture a different account's
    // current collection when restored through Back/Forward.
    if (trigger !== 'imperative') return null;
    const filters = this.store.filters();
    return { owner: this.viewerOwner, refinable: this.store.pinnedPaths() === null && !filters.similar_to,
      params: { ...buildSyncParams(filters, this.store.config()?.defaults, this.store.config()?.search_threshold_default, this.store.currentAlbum()?.smart_filter_json),
        ...(this.store.temporaryReviewQueue() ? { review_queue: '1' } : {}) } };
  }

  private rememberTagOrigin(): void {
    this.location.replaceState(this.location.path(true), '', {
      ...this.location.getState() as Record<string, unknown>, photoTagOrigin: this.tagOrigin(), photoBack: this.openedFromGallery,
    });
  }

  private photoNavigationState(photo: Photo | undefined): Record<string, unknown> {
    return { photo, photoSession: this.viewerSession, photoTagOrigin: this.tagOrigin(), photoBack: this.openedFromGallery };
  }

  private logicalChangeRevision = 0;

  protected async onLogicalAssetApplied(change: LogicalAssetApplied): Promise<void> {
    const previous = this.photo()?.path;
    if (!previous || this.viewerOwner !== this.auth.identity() || !change.members.includes(previous)) return;
    const revision = ++this.logicalChangeRevision;
    const token = this.auth.token;
    this.store.reconcileLogicalAssetChange(change);
    const target = change.operation !== 'dissolve' && change.primaryPath && this.memberAllowed(change.primaryPath)
      ? change.primaryPath : previous;
    const photo = await this.fetchPhoto(target).catch(() => undefined);
    if (revision !== this.logicalChangeRevision || !this.isCurrentViewer() || token !== this.auth.token
      || this.photo()?.path !== previous || this.route.snapshot.queryParamMap.get('path') !== previous
      || this.router.currentNavigation?.()) return;
    if (!photo) {
      this.snackBar.open(this.i18n.t(I18N.logical_assets.refresh_error), '', { duration: 5000 });
      return;
    }
    if (target === previous) this.photo.set(photo);
    else {
      const member = { photo, owner: this.auth.identity() };
      this.memberPhoto = member;
      try {
        await this.router.navigate(['/photo'], { queryParams: { path: target }, state: this.photoNavigationState(photo), replaceUrl: true });
      } finally {
        if (this.memberPhoto === member) this.memberPhoto = null;
      }
    }
  }

  protected openCollectionPhoto(path: string): void {
    if (!this.collectionSidebarAvailable() || path === this.photo()?.path || !this.memberAllowed(path)) return;
    const photo = this.store.photos().find(item => item.path === path);
    if (!photo) return;
    void this.router.navigate(['/photo'], { queryParams: { path }, state: this.photoNavigationState(photo), replaceUrl: true });
  }

  protected loadCollectionPage(): void {
    if (!this.collectionSidebarAvailable() || this.store.loading() || !this.store.hasMore()) return;
    void this.store.nextPage(undefined, { whileParked: true });
  }

  readonly photo = signal<Photo | null>(null);
  /** Plugin overlays for the open photo (a plate solve's labels), drawn by the annotation layer. */
  protected readonly annotations = inject(PhotoAnnotationsState);
  private readonly photoPath = computed(() => this.photo()?.path ?? null);
  /** Bumped when the mark dialog adds or removes an object, so the object layer re-reads. */
  protected readonly objectsRevision = signal(0);
  protected readonly photoMissing = signal(false);
  protected readonly downloading = signal(false);
  protected readonly copyingPhoto = signal(false);
  protected readonly downloadOptions = signal<DownloadOption[]>([]);
  protected readonly generatingCaption = signal(false);
  protected readonly stars: readonly number[] = [1, 2, 3, 4, 5];

  // Category explainer ("why isn't this photo classified as X?")
  protected readonly explainerCategories = signal<string[]>([]);
  protected readonly explainerTargetCategory = signal<string | null>(null);
  protected readonly explainerLoadFailed = signal(false);

  // Face boxes: off, on hover, or always shown. Remembered per browser.
  protected readonly faceBoxMode = signal<FaceBoxMode>(readFaceBoxMode());
  protected readonly faceBoxModeIcon = computed(() => FACE_BOX_MODE_ICONS[this.faceBoxMode()]);
  protected readonly faceBoxModeLabel = computed(() => FACE_BOX_MODE_LABELS[this.faceBoxMode()]);
  /** The gallery's person filter: those persons' faces stay boxed while browsing them. */
  protected readonly focusPersonIds = computed(() =>
    (this.store.filters().person_id || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0));

  /** Hover, then always, then off, then hover again. */
  protected cycleFaceBoxMode(): void {
    const next = nextFaceBoxMode(this.faceBoxMode());
    this.faceBoxMode.set(next);
    writeFaceBoxMode(next);
  }

  // Download options
  private downloadOptionsEffect = effect(() => {
    const p = this.photo();
    if (!p) { this.downloadOptions.set([]); return; }
    if (!this.auth.downloadProfiles().length) {
      this.downloadOptions.set([{ type: 'original', label: 'original' }]);
      return;
    }
    const requestedPath = p.path;
    firstValueFrom(this.api.get<{ options: DownloadOption[] }>('/download/options', { path: requestedPath }))
      .then(res => { if (this.photo()?.path === requestedPath) this.downloadOptions.set(res.options); })
      .catch(() => { if (this.photo()?.path === requestedPath) this.downloadOptions.set([{ type: 'original', label: 'original' }]); });
  });

  // Social-export crop presets (from viewer config) + which signal frames the crop
  protected readonly HISTOGRAM_PANEL_HEIGHT = HISTOGRAM_PANEL_HEIGHT;
  /** House default for the histogram's channels, until the user picks one.
   *  A stale/unrecognised config value degrades to 'rgb' rather than the
   *  widget rendering nothing. */
  protected readonly histogramDefaultMode = computed<HistogramMode>(() => {
    const configured = this.store.config()?.clipping?.histogram_mode;
    return isHistogramMode(configured) ? configured : 'rgb';
  });
  protected readonly clippingIndicatorPercent = computed(
    () => this.store.config()?.clipping?.indicator_percent ?? 1);

  protected readonly socialPresets = computed(() => this.store.config()?.social_export?.presets ?? []);
  protected readonly socialExportEnabled = computed(() =>
    this.auth.isEdition() && !!this.store.config()?.features?.show_social_export && this.socialPresets().length > 0,
  );
  protected readonly socialCropSource = signal<string | null>(null);
  protected readonly socialCropTooltipKey = computed(() => {
    const source = this.socialCropSource();
    const key = source ? (SOCIAL_SOURCE_KEYS[source] ?? null) : null;
    return key ?? I18N.photo_detail.social_crop;
  });
  private socialCropSourceEffect = effect(() => {
    const p = this.photo();
    const presets = this.socialPresets();
    // The server answers 422 for a photo whose stored dimensions are missing, so don't ask.
    if (!p || !this.socialExportEnabled() || !p.image_width || !p.image_height) {
      this.socialCropSource.set(null);
      return;
    }
    const requestedPath = p.path;
    firstValueFrom(this.api.get<{ source: string }>('/photo/social_crop/preview', { path: requestedPath, preset: presets[0].key }))
      .then(res => { if (this.photo()?.path === requestedPath) this.socialCropSource.set(res.source); })
      .catch(() => { if (this.photo()?.path === requestedPath) this.socialCropSource.set(null); });
  });

  protected readonly keeperHint = signal<KeeperHint | null>(null);
  private keeperHintEffect = effect(() => {
    const p = this.photo();
    this.keeperHint.set(null);
    if (!p) return;
    const requestedPath = p.path;
    firstValueFrom(this.api.post<Record<string, KeeperHint>>('/photos/keeper_hints', { paths: [requestedPath] }))
      .then(hints => { if (this.photo()?.path === requestedPath) this.keeperHint.set(hints[requestedPath] ?? null); })
      .catch(() => { if (this.photo()?.path === requestedPath) this.keeperHint.set(null); });
  });

  // Set membership (bracket/panorama/hdr_panorama/burst/duplicate)
  protected readonly photoSet = signal<PhotoSet | null>(null);
  private readonly photoSetPending = signal(false);
  /** Blink frames in the set: the gallery hides them by default, so saying so here
   *  explains why "Open in gallery" can list fewer photos than the set holds. */
  protected readonly setBlinkCount = computed(() => this.photoSet()?.members.filter(m => m.is_blink).length ?? 0);
  /** The strip's order: the frames the gallery keeps, then AI edits, then the blinks it drops. */
  protected readonly setStripMembers = computed(() => {
    const members = this.photoSet()?.members ?? [];
    const rank = (m: PhotoSetMember) => (m.is_blink ? 2 : m.ai_edit_of ? 1 : 0);
    return [...members].sort((a, b) => rank(a) - rank(b));
  });
  private photoSetEffect = effect(() => {
    const p = this.photo();
    this.photoSet.set(null);
    this.photoSetPending.set(!!p);
    if (!p) return;
    const requestedPath = p.path;
    firstValueFrom(this.api.get<PhotoSet>('/photo/set', { path: requestedPath }))
      .then(res => { if (this.photo()?.path === requestedPath) { this.photoSet.set(res); this.photoSetPending.set(false); } })
      .catch(() => { if (this.photo()?.path === requestedPath) { this.photoSet.set(null); this.photoSetPending.set(false); } });
  });

  // Location
  protected readonly locationName = signal('');
  /** Whether the location's map and exact coordinates are open; folded by default, remembered per browser. */
  protected readonly locationOpen = signal(readLocationOpen());

  protected toggleLocation(): void {
    this.locationOpen.update(open => !open);
    try { localStorage.setItem(LOCATION_OPEN_KEY, String(this.locationOpen())); } catch { /* Storage blocked: the choice holds for this page only. */ }
  }
  private locationNameEffect = effect(() => {
    const p = this.photo();
    if (!p || p.gps_latitude == null || p.gps_longitude == null) {
      this.locationName.set('');
      return;
    }
    const requestedPath = p.path;
    firstValueFrom(this.api.get<{ display_name: string }>('/filter_options/location_name', {
      lat: String(p.gps_latitude), lng: String(p.gps_longitude),
    }))
      .then(res => { if (this.photo()?.path === requestedPath) this.locationName.set(res.display_name || ''); })
      .catch(() => { if (this.photo()?.path === requestedPath) this.locationName.set(''); });
  });

  private readonly locationMapContainer = viewChild<ElementRef<HTMLDivElement>>('locationMapContainer');
  private locationMap: L.Map | null = null;
  private locationMapTimeout: ReturnType<typeof setTimeout> | null = null;

  private locationMapEffect = effect(() => {
    const container = this.locationMapContainer();
    const p = this.photo();
    // The map is built only while the section is open, once it has its size, so it never measures a hidden box.
    const open = this.locationOpen() && this.rail.shownPage() === 'content' && !this.rail.addonActive();
    const tiles = this.mapSource.tiles(this.store.config());
    if (this.locationMapTimeout !== null) {
      clearTimeout(this.locationMapTimeout);
      this.locationMapTimeout = null;
    }
    if (this.locationMap) {
      this.locationMap.remove();
      this.locationMap = null;
    }

    if (!open || !container || !p || p.gps_latitude == null || p.gps_longitude == null) return;
    this.locationMapTimeout = setTimeout(() => {
      this.locationMapTimeout = null;
      if (this.destroyRef.destroyed || this.locationMapContainer()?.nativeElement !== container.nativeElement || this.photo()?.path !== p.path) return;
      const map = createLeafletMap(container.nativeElement, {
        zoomControl: false,
        // The static preview hides the attribution row for the default OSM
        // layer; a source that requires visible attribution shows it.
        attributionControl: tiles.url !== OSM_TILES.url,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
      }, undefined, tiles).setView([p.gps_latitude!, p.gps_longitude!], 13);

      L.marker([p.gps_latitude!, p.gps_longitude!]).addTo(map);
      this.locationMap = map;
    }, 0);
  });

  constructor() {
    super();
    let trigger: 'imperative' | 'popstate' | 'hashchange' = 'imperative';
    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event instanceof NavigationStart) { this.logicalChangeRevision++; trigger = event.navigationTrigger ?? 'imperative'; }
      if (event instanceof NavigationEnd) {
        this.openedFromGallery = this.readBackOwnership(this.location.getState());
        this.tagOrigin.set(this.readTagOrigin(this.location.getState(), trigger));
        this.rememberTagOrigin();
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.locationMapTimeout !== null) clearTimeout(this.locationMapTimeout);
      if (this.locationMap) { this.locationMap.remove(); this.locationMap = null; }
    });
    this.assistantChanges.batch$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(batch => void this.refreshAfterAssistant(batch));
    this.store.organizationRestored$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refreshAfterRestore());
    // Keyed on the path, so a rating or tag change on the same photo does not re-read its annotations.
    effect(() => { const path = this.photoPath(); untracked(() => void this.annotations.load(path)); });
  }

  /** An Organization history restore may have rewritten this photo; a newer local edit wins over the reply. */
  private async refreshAfterRestore(): Promise<void> {
    const previous = this.photo();
    if (!previous) return;
    const fresh = await this.fetchPhoto(previous.path).catch(() => undefined);
    if (fresh && this.photo() === previous) this.photo.set(fresh);
  }

  /** An assistant write touched this page's photo (or an unenumerable scope): refetch the full detail row. */
  private async refreshAfterAssistant(batch: AssistantChangeBatch): Promise<void> {
    const path = this.photo()?.path;
    if (!path || (batch.paths !== null && !batch.paths.includes(path))) return;
    try {
      const fresh = await this.fetchPhoto(path);
      // The user moved to another photo (ArrowRight) while this was in flight.
      if (this.photo()?.path === path) this.photo.set(fresh);
    } catch (err) {
      if (this.photo()?.path !== path) return;
      // Only a missing photo has no page left; any other failure keeps the page the user is on.
      if ((err as { status?: number }).status === 404) this.goBack();
      else this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  async ngOnInit(): Promise<void> {
    this.rememberTagOrigin();
    void this.store.ensureMetricRanges();
    // Back/Forward between two photos reuses this component instead of creating a new one.
    this.route.queryParamMap.pipe(skip(1), takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const path = params.get('path');
      if (path && path !== this.photo()?.path) void this.showPhotoAt(path);
    });

    const path = this.route.snapshot.queryParamMap.get('path');
    // History survives logout and even document reloads. Only a snapshot from
    // this credential session and this route may bypass a fresh authorized read.
    const statePhoto = history.state?.['photo'] as Photo | undefined;

    if (statePhoto?.path === path && history.state?.['photoSession'] === this.viewerSession) {
      this.photo.set(normalisePhotoFlags(statePhoto));
    } else {
      // Fallback: load from API using query param
      if (path) {
        // The user may leave, or Back may move the address, while this loads; replacing keeps a dead entry out of history.
        const photo = await this.fetchPhoto(path).catch(() => undefined);
        if (!this.isCurrentViewer() || this.route.snapshot.queryParamMap.get('path') !== path) return;
        if (photo) this.photo.set(photo);
        else this.router.navigate(['/'], { replaceUrl: true });
      } else {
        this.router.navigate(['/'], { replaceUrl: true });
      }
    }
  }

  private async fetchPhoto(path: string): Promise<Photo> {
    const photo = normalisePhotoFlags(
      await firstValueFrom(this.api.get<Photo>('/photo', { path })));
    if (!photo.tags_list) {
      photo.tags_list = photo.tags ? photo.tags.split(',').map(t => t.trim()) : [];
    }
    if (!photo.manual_tags) {
      photo.manual_tags = [];
    }
    if (!photo.persons) {
      photo.persons = [];
    }
    return photo;
  }

  private async showPhotoAt(path: string): Promise<void> {
    if (this.viewerOwner !== this.auth.identity() || this.viewerSession !== privateImageSessionKey() || (this.memberPhoto?.photo.path === path && !this.memberAllowed(path))) return;
    // Store copy carries edits made since; history.state is the photo as opened.
    const context = this.stacks.context();
    const photo = (this.memberPhoto?.owner === this.auth.identity() && this.memberPhoto.photo.path === path ? this.memberPhoto.photo : null) ?? this.store.photos().find(p => p.path === path) ?? await this.fetchPhoto(path).catch(() => undefined);
    if (this.destroyRef.destroyed || !context() || this.route.snapshot.queryParamMap.get('path') !== path) return;
    if (!photo) {
      // Say so rather than keep the previous photo under this address (e.g. Forward to one deleted since).
      this.photo.set(null);
      this.photoMissing.set(true);
      return;
    }
    this.photoMissing.set(false);
    this.photo.set(photo);
  }

  private memberAllowed(path: string): boolean {
    const pinned = this.store.pinnedPaths();
    return pinned === null || pinned.includes(path);
  }

  protected async openSetMember(path: string): Promise<void> {
    if (this.viewerOwner !== this.auth.identity() || this.viewerSession !== privateImageSessionKey() || !this.memberAllowed(path) || this.photo()?.path === path) return;
    const sequence = ++this.memberRequest;
    const currentPath = this.photo()?.path;
    const context = this.stacks.context();
    const current = () => !this.destroyRef.destroyed && context() && sequence === this.memberRequest && this.photo()?.path === currentPath && this.memberAllowed(path);
    try {
      const photo = await this.fetchPhoto(path);
      if (!current()) return;
      this.memberPhoto = { photo, owner: this.auth.identity() };
      try {
        await this.stacks.navigateMember(path, photo, () => this.memberAllowed(path), true);
      } finally { this.memberPhoto = null; }
    } catch {
      if (!current()) return;
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  protected openSetInGallery(): void {
    const set = this.photoSet();
    if (!set?.kind || set.group_id == null) return;
    const groupId = String(set.group_id);
    const updates = setScopePatch(
      set.kind === 'burst' || set.kind === 'duplicate' ? set.kind : 'sequence', groupId, set.kind,
    );
    // Carried via router navigation state, never the URL or a post-navigate
    // updateFilters() call: the gallery route re-initialises its filters from
    // config + localStorage + URL on activation, which either overwrites a
    // post-navigate update or discards it as arriving too late. `state` is
    // read by GalleryComponent.ngOnInit before its first load. See
    // GalleryComponent.consumeSetScopeState for why it is also never
    // bookmarkable: sequence_group_id is renumbered on every detection pass.
    this.router.navigate(['/'], { state: { setScope: updates } });
  }

  private shortcutBlocked(event: Event): boolean {
    return event.defaultPrevented || isPageShortcutBlocked(event as KeyboardEvent) || this.store.slideshowActive();
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected goBack(event?: Event): void {
    if (event && this.shortcutBlocked(event)) return;
    event?.preventDefault();
    if (this.openedFromGallery) this.location.back();
    else void this.router.navigate(['/'], { queryParams: this.store.readGallerySessionQuery() ?? undefined, replaceUrl: true });
  }

  @HostListener('document:keydown.arrowleft', ['$event'])
  protected prevPhoto(event: Event): void {
    if (this.shortcutBlocked(event)) return;
    event.preventDefault();
    void this.navigateAdjacentPhoto(-1);
  }

  @HostListener('document:keydown.arrowright', ['$event'])
  protected nextPhoto(event: Event): void {
    if (this.shortcutBlocked(event)) return;
    event.preventDefault();
    void this.navigateAdjacentPhoto(1);
  }

  @HostListener('document:keydown.arrowup', ['$event'])
  protected previousCollectionPhoto(event: Event): void { this.collectionArrow(event, -1); }

  @HostListener('document:keydown.arrowdown', ['$event'])
  protected nextCollectionPhoto(event: Event): void { this.collectionArrow(event, 1); }

  /**
   * Up/Down move along the collection, past any stack or set, while Left/Right walk
   * the open photo's set first. Only where the page itself does not scroll (lg+), and
   * never inside the inspector or the collection list, whose arrows scroll them.
   */
  private collectionArrow(event: Event, delta: number): void {
    if (this.shortcutBlocked(event) || !matchMedia('(min-width: 1024px)').matches || this.inScrollRegion(event.target)
      || (this.lastPointerTarget?.isConnected && this.inScrollRegion(this.lastPointerTarget))
      || (!this.timelineOrigin && !this.collectionNavigation().visible)) return;
    event.preventDefault();
    void this.navigateAdjacentPhoto(delta, true);
  }

  /** Clicking the inspector's or the sidebar's text leaves focus on the page, yet the browser
   *  scrolls that region with the arrows: the last pointer press tells which region the user is in. */
  private lastPointerTarget: Element | null = null;
  @HostListener('document:pointerdown', ['$event'])
  protected notePointerTarget(event: Event): void { this.lastPointerTarget = event.target as Element | null; }
  private inScrollRegion(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest?.('[data-photo-inspector], [data-collection-scroller]');
  }

  /** Up/Down past the sidebar's first or last thumbnail: step along the collection, which pages as needed. */
  protected stepCollection(delta: number): void { void this.navigateAdjacentPhoto(delta, true); }

  /** The mapped rating keys act on the open photo — the same keys the grid's
   *  focused card answers, so a reviewer never has to reach for the panel.
   *  Gated the same way the rating buttons are (edition mode + the
   *  rating-controls feature flag); typing contexts and open dialogs bow out
   *  first. No auto-advance: a single-photo view has no "next" contract with
   *  the filters it came from. */
  protected onRatingShortcut(event: KeyboardEvent): void {
    if (isPageShortcutBlocked(event)) return;
    if (!this.canReview() || !this.store.config()?.features?.show_rating_controls) return;
    const p = this.photo();
    if (!p) return;
    if (event.key >= '1' && event.key <= '5') {
      event.preventDefault();
      void this.setRating(p.path, Number(event.key));
    } else if (this.keymap.matches(event, 'favourite')) {
      event.preventDefault();
      void this.toggleFavorite(p.path);
    } else if (event.key === '0' || this.keymap.matches(event, 'reject')) {
      event.preventDefault();
      void this.toggleRejected(p.path);
    }
  }

  private async navigateAdjacentPhoto(delta: number, withinCollection = false): Promise<void> {
    if (this.timelineOrigin) {
      const path = this.photo()?.path;
      const next = path ? this.timeline?.adjacent(path, delta) : null;
      if (next) await this.router.navigate(['/photo'], {
        queryParams: { path: next }, state: { photoOrigin: 'timeline' }, replaceUrl: true,
      });
      return;
    }
    // Match the visible stack buttons; its members already respect an exact list.
    // Expanded stacks are collection rows, so the collection order owns the arrows.
    if (!withinCollection && this.store.collapseStacks() && this.stackNavigator()?.step(delta)) return;
    if (!withinCollection && this.stepSetSibling(delta)) return;
    const current = this.photo();
    if (!current) return;
    const indexOf = () => this.store.photos().findIndex(p => p.path === this.collectionEntry()?.path);
    let idx = indexOf();
    if (idx === -1) return;
    // The store only holds the pages the grid has scrolled through, so stepping past the last one fetches the next.
    if (idx + delta >= this.store.photos().length && this.store.hasMore()) {
      await this.store.nextPage(undefined, { whileParked: true });
      // Back between two photos reuses this component, so the URL is checked as well as destroyed.
      if (this.destroyRef.destroyed || this.viewerOwner !== this.auth.identity() || this.photo()?.path !== current.path
        || this.route.snapshot.queryParamMap.get('path') !== current.path) return;
      idx = indexOf();
      if (idx === -1) return;
    }
    const next = this.store.photos()[idx + delta];
    if (!next) return;
    // Replace, so Escape (history back) leaves the photo page instead of stepping back through every photo.
    this.router.navigate(['/photo'], {
      queryParams: { path: next.path },
      state: this.photoNavigationState(next),
      replaceUrl: true,
    });
    this.photo.set(next);
  }

  /**
   * Steps to the neighbouring frame in the Set strip's order. False at the strip's
   * ends or outside a set, so the arrows carry on through the collection; true while
   * a grouped photo's set is still loading, so they cannot skip past it.
   */
  private stepSetSibling(delta: number): boolean {
    const current = this.photo();
    // A folded stack owns Left/Right: past its ends they go to the collection, not into a set.
    if (!current || (current.stack_id != null && this.store.collapseStacks())) return false;
    // Once the gallery lists several frames of the set, their order owns the arrows, as it does
    // for expanded stacks: walking the strip as well would cycle between the two orders.
    if (this.store.photos().filter(photo => sharesSet(photo, current)).length > 1) return false;
    const set = this.photoSet();
    if (!set) return this.photoSetPending() && inDetectedSet(current);
    if (!set.kind) return false;
    const members = this.setStripMembers().filter(member => this.memberAllowed(member.path));
    const index = members.findIndex(member => member.path === current.path);
    const next = index < 0 ? undefined : members[index + delta];
    if (!next) return false;
    void this.openSetMember(next.path);
    return true;
  }

  protected async copyPhoto(path: string): Promise<void> {
    if (this.copyingPhoto()) return;
    const photo = this.photo();
    if (!photo || photo.path !== path) return;
    const owner = this.auth.identity(), token = this.auth.token;
    const current = () => !this.destroyRef.destroyed && this.photo()?.path === path
      && this.auth.identity() === owner && this.auth.token === token;
    this.copyingPhoto.set(true);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard unavailable');
      const image = firstValueFrom(this.api.getRaw(this.api.imageUrl(path, photo.preview_revision))).then(async blob => {
        if (!current()) throw new Error('Photo changed');
        const bitmap = await createImageBitmap(blob);
        try {
          if (!current()) throw new Error('Photo changed');
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Image conversion unavailable');
          context.drawImage(bitmap, 0, 0);
          const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image conversion failed')), 'image/png'));
          if (!current()) throw new Error('Photo changed');
          return png;
        } finally { bitmap.close(); }
      });
      // Some browsers reject clipboard access before consuming the promised image.
      void image.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      if (current()) this.snackBar.open(this.i18n.t(I18N.photo_detail.copy_image_done), '', { duration: 3000 });
    } catch {
      if (current()) this.snackBar.open(this.i18n.t(I18N.photo_detail.copy_image_failed), '', { duration: 4000 });
    } finally { this.copyingPhoto.set(false); }
  }

  protected async download(path: string, type = 'original', profile?: string): Promise<void> {
    this.downloading.set(true);
    try {
      await downloadFile(this.api.getRaw(this.api.downloadUrl(path, type, profile)), basename(path));
    } catch {
      // A 404 (the file moved on disk) or a 412 passes the interceptor's 5xx
      // toast silently — the click must not look like a no-op.
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    } finally {
      this.downloading.set(false);
    }
  }

  protected async downloadSocialCrop(path: string, preset: string): Promise<void> {
    this.downloading.set(true);
    try {
      await downloadFile(
        this.api.getRaw(`/api/photo/social_crop?path=${encodeURIComponent(path)}&preset=${encodeURIComponent(preset)}`),
        basename(path),
      );
    } catch {
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    } finally {
      this.downloading.set(false);
    }
  }

  /**
   * Apply the fields the server has confirmed to the open photo and to the
   * gallery's copy of it.
   *
   * The store write is what makes an edit outlive the lightbox: the grid
   * renders from `GalleryStore.photos()`, so a mutation that only reached
   * this component's own signal was shown back at its pre-edit value the
   * moment the user returned, and looked discarded even though the server
   * had accepted it.
   *
   * One partial feeds both, so the two views cannot be given different
   * fields — which matters most where the server couples them: a reject that
   * also clears the stars and the favorite flag has to carry all three, and
   * the store used to receive none of them.
   *
   * Only ever called with state the server has already acknowledged, so a
   * failed call leaves both the signal and the store untouched — the same
   * pessimistic shape every handler here already had, and one that needs no
   * revert path.
   */
  protected async openManualFaces(p: Photo): Promise<void> {
    const path = p.path;
    const { ManualFaceDialogComponent } = await import('./manual-face-dialog.component');
    if (this.destroyRef.destroyed || this.photo()?.path !== path) return;
    this.dialog.open(ManualFaceDialogComponent, {
      width: '800px', maxWidth: '96vw',
      data: { path, filename: p.filename, onCommitted: () => this.onPersonMenuChanged(path),
        onObjectsChanged: () => this.objectsRevision.update(n => n + 1) },
    });
  }

  /**
   * Re-read a photo's people from the server after a face changed hands, from the
   * manual-face editor or the face layer. The server's answer replaces the store's
   * optimistic patch, which cannot know whether a moved face emptied its old person.
   */
  protected async refreshPeople(path: string): Promise<void> {
    try {
      const actual = await firstValueFrom(this.api.get<Photo>('/photo', { path }));
      const patch = { persons: actual.persons, unassigned_faces: actual.unassigned_faces };
      this.store.patchPhoto(path, patch);
      if (!this.destroyRef.destroyed && this.photo()?.path === path) {
        this.photo.update(current => current ? { ...current, ...patch } : current);
      }
      await this.store.reloadPersonOptions();
      if (this.store.filters().person_id || this.store.filters().manual_faces_need_review || this.store.filters().faces_need_names) {
        await this.store.refreshPaths([path]);
      }
    } catch {
      // The edit itself is saved; a failed re-read leaves the optimistic state until the next load.
    }
  }

  private applyConfirmed(p: Photo, confirmed: Partial<Photo>): void {
    void this.store.loadReviewProgress();
    this.store.patchPhoto(p.path, confirmed);
    // The page may have moved on, or taken another edit, since p was read.
    const current = this.photo();
    if (!this.destroyRef.destroyed && current?.path === p.path) {
      this.photo.set({ ...current, ...confirmed });
    }
  }

  protected readonly canReview = computed(() => this.auth.isEdition() || !!(this.auth.status()?.multi_user && this.auth.status()?.authenticated));
  /** Keep/Undecided on an ordinary photo go to an edition-only endpoint; a logical-review photo saves through the account endpoint. */
  protected readonly canDecide = computed(() => this.auth.isEdition() || !!this.photo()?.logical_review);
  private readonly logicalReviews = inject(LogicalReviewService);

  private async saveLogicalReview(p: Photo, action: LogicalReviewAction): Promise<boolean> {
    const state = p.logical_review;
    if (!state) return false;
    const guard = this.staleness.create(this.destroyRef, { requireEdition: false, valid: () =>
      this.canReview() && this.photo()?.path === p.path && this.photo()?.logical_review?.input_token === state.input_token });
    try {
      const result = await this.logicalReviews.save(state, action, guard.current);
      if (!result) return false;
      await this.store.applyLogicalReview(result);
      if (!guard.current()) return false;
      this.photo.set(normalisePhotoFlags({ ...this.photo()!, logical_review: result }));
      return true;
    } catch (error) {
      const current = guard.current();
      if (current && error instanceof LogicalReviewWriteError && error.recovered) {
        await this.store.applyLogicalReview(error.recovered);
        if (!guard.current()) return false;
        this.photo.set(normalisePhotoFlags({ ...this.photo()!, logical_review: error.recovered }));
      }
      if (current) this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
      return false;
    } finally { guard.dispose(); }
  }

  private isCurrentViewer(): boolean {
    return !this.destroyRef.destroyed && this.viewerOwner === this.auth.identity() && this.viewerSession === privateImageSessionKey();
  }

  protected async setRating(path: string, rating: number): Promise<void> {
    const p = this.photo();
    if (!p || p.path !== path) return;
    const newRating = p.star_rating === rating ? 0 : rating;
    if (p.logical_review) { await this.saveLogicalReview(p, { rating: newRating }); return; }
    const sameSession = captureSession(this.auth);
    try {
      await firstValueFrom(this.api.post('/photo/set_rating', { photo_path: path, rating: newRating }));
      // A confirmed write still repairs the same session's gallery after navigation.
      if (!sameSession()) return;
      this.applyConfirmed(p, { star_rating: newRating });
      this.journal.record('rating', [path], newRating);
    } catch {
      if (sameSession() && !this.destroyRef.destroyed) this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected onReviewKey(event: KeyboardEvent): void {
    this.onRatingShortcut(event);
    if (this.dialog.openDialogs.length || isPageShortcutBlocked(event) || !this.keymap.matches(event, 'keep') || !this.canReview() || !this.canDecide()) return;
    event.preventDefault();
    void this.reviewPhoto('kept');
  }

  protected async reviewPhoto(decision: 'kept' | 'undecided'): Promise<void> {
    const p = this.photo();
    if (!p || this.reviewSaving) return;
    this.reviewSaving = true;
    const isOrigin = this.store.captureReviewView();
    const sameSession = captureSession(this.auth);
    const photos = this.store.photos();
    const index = photos.findIndex(photo => photo.path === p.path);
    const next = photos[index + 1];
    try {
      if (p.logical_review) {
        if (!await this.saveLogicalReview(p, decision)) return;
      } else {
        await firstValueFrom(this.api.post('/photos/batch_review', { photo_paths: [p.path], decision }));
        if (!sameSession()) return;
        this.applyConfirmed(p, { is_kept: decision === 'kept', is_rejected: false });
        this.journal.record('review', [p.path], decision);
      }
      if (isOrigin()) await this.advanceAfterReview(p, index, next);
    } catch {
      if (sameSession() && !this.destroyRef.destroyed) this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    } finally { this.reviewSaving = false; }
  }

  private reviewSaving = false;

  private async advanceAfterReview(previous: Photo, index: number, next?: Photo): Promise<void> {
    // Timeline owns a captured preview sequence, not the parked Gallery queue.
    if (this.timelineOrigin) return;
    if (!this.store.filters().review_status) return;
    const owner = this.auth.identity(), token = this.auth.token;
    let navigated = false;
    const navigation = this.router.events.subscribe(event => {
      if (event instanceof NavigationStart) navigated = true;
    });
    try {
      await this.store.refreshReviewResults(false, { whileParked: true });
      if (navigated || this.destroyRef.destroyed || this.photo()?.path !== previous.path
        || owner !== this.auth.identity() || token !== this.auth.token) return;
      const target = this.store.photos().find(photo => photo.path === next?.path) ?? this.store.photos()[index] ?? this.store.photos()[0];
      if (!target) { this.router.navigate(['/']); return; }
      this.router.navigate(['/photo'], { queryParams: { path: target.path }, state: this.photoNavigationState(target), replaceUrl: true });
      this.photo.set(target);
    } finally { navigation.unsubscribe(); }
  }

  protected async toggleFavorite(path: string): Promise<void> {
    const p = this.photo();
    if (!p || p.path !== path) return;
    if (p.logical_review) { await this.saveLogicalReview(p, 'favorite'); return; }
    const sameSession = captureSession(this.auth);
    try {
      const res = await firstValueFrom(this.api.post<{ is_favorite: boolean; is_rejected: boolean | null }>('/photo/toggle_favorite', { photo_path: path }));
      if (!sameSession()) return;
      const confirmed: Partial<Photo> = { is_favorite: res.is_favorite };
      // null means "the server did not touch this one": leave both readers on
      // the value they hold rather than writing this view's belief over the
      // store's, which may be the fresher of the two.
      if (res.is_rejected !== null) confirmed.is_rejected = res.is_rejected;
      this.applyConfirmed(p, confirmed);
      this.journal.record('favorite', [path], res.is_favorite);
    } catch {
      if (sameSession() && !this.destroyRef.destroyed) this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  protected async toggleRejected(path: string): Promise<void> {
    const p = this.photo();
    if (!p || p.path !== path) return;
    const isOrigin = this.store.captureReviewView();
    const sameSession = captureSession(this.auth);
    const photos = this.store.photos();
    const index = photos.findIndex(photo => photo.path === p.path);
    const next = photos[index + 1];
    if (p.logical_review) {
      if (await this.saveLogicalReview(p, 'reject') && isOrigin()) await this.advanceAfterReview(p, index, next);
      return;
    }
    try {
      const res = await firstValueFrom(this.api.post<{ is_rejected: boolean; is_favorite: boolean | null; star_rating: number | null }>('/photo/toggle_rejected', { photo_path: path }));
      const confirmed: Partial<Photo> = { is_rejected: res.is_rejected, is_kept: false };
      if (res.is_favorite !== null) confirmed.is_favorite = res.is_favorite;
      if (res.star_rating !== null) confirmed.star_rating = res.star_rating;
      // Repair the gallery only while the initiating credentials still own it.
      if (!sameSession()) return;
      this.applyConfirmed(p, confirmed);
      this.journal.record('reject', [path], res.is_rejected);
      if (isOrigin()) await this.advanceAfterReview(p, index, next);
    } catch {
      if (sameSession() && !this.destroyRef.destroyed) this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  protected async generateCaption(path: string): Promise<void> {
    this.generatingCaption.set(true);
    try {
      const res = await firstValueFrom(this.api.post<{ caption: string }>('/caption', { path }));
      const p = this.photo();
      // Generation is slow enough to outlive the photo that started it, and the
      // store write now carries a mis-targeted apply out to the grid as well --
      // so confirm the open photo is still the one this call asked about.
      if (p?.path === path) {
        this.translatedCaption.set(null);
        this.applyConfirmed(p, { caption: res.caption, caption_translated: undefined });
      }
    } catch {
      this.snackBar.open(this.i18n.t(I18N.photo_detail.caption_error), '', { duration: 3000 });
      // A failed request resolves an 'auto' VRAM profile, so the config can now hide the button.
      await this.store.refreshConfig();
    } finally {
      this.generatingCaption.set(false);
    }
  }

  /**
   * The Persons list opens the same menu as the photo's faces, on this photo's face
   * of that person (its largest when several), so it works with the boxes off too.
   */
  protected openPersonMenu(person: { id: number; name: string | null }, event: Event): void {
    const face = this.faceLayer()?.faceOf(person.id) ?? null;
    this.personMenu()?.openBelow({ person: { id: person.id, name: person.name }, face }, event.currentTarget as HTMLElement);
  }

  protected async onPersonMenuChanged(path: string): Promise<void> {
    if (!this.destroyRef.destroyed && this.photo()?.path === path) {
      await this.faceLayer()?.load(path);
    }
    await this.refreshPeople(path);
  }

  protected navigateTag(tag: string, scope: 'collection' | 'library'): void {
    if (!this.isCurrentViewer()) return;
    if (scope === 'collection' && !this.tagCollectionAvailable()) return;
    const query = refineTagQuery(scope === 'collection' ? this.tagOrigin()!.params['tag_groups'] ?? '' : '', tag);
    if (query === null) {
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
      return;
    }
    const params = scope === 'collection' ? this.tagOrigin()!.params : {};
    this.router.navigate(['/'], { info: GALLERY_REVISIT, queryParams: { ...params, tag_groups: query } });
  }

  protected readonly newTag = signal('');
  /** The manual-tag input shows on demand, from + Tag, so an untagged photo costs one compact action. */
  protected readonly tagInputOpen = signal(false);
  private readonly injector = inject(Injector);
  private readonly describe = viewChild<ElementRef<HTMLElement>>('describe');

  protected openTagInput(): void {
    this.tagInputOpen.set(true);
    afterNextRender(() => this.describe()?.nativeElement.querySelector<HTMLInputElement>('[data-testid="manual-tag-add"] input')?.focus(), { injector: this.injector });
  }

  protected closeTagInput(event: Event): void {
    event.preventDefault();
    this.newTag.set('');
    this.tagInputOpen.set(false);
    afterNextRender(() => this.describe()?.nativeElement.querySelector<HTMLElement>('[data-add-tag]')?.focus(), { injector: this.injector });
  }

  protected onNewTagInput(event: Event): void {
    this.newTag.set((event.target as HTMLInputElement).value);
  }

  /**
   * Pessimistic: the signal and the store change only once the server accepted the tag.
   * The merge reads the CURRENT photo when the response lands, so overlapping edits compose.
   */
  protected async addManualTag(p: Photo, raw: string): Promise<void> {
    const tag = raw.trim();
    if (!tag) return;
    try {
      const res = await firstValueFrom(
        this.api.put<{ tag: string; skipped_existing: boolean }>('/photo/manual_tags', { path: p.path, tag }));
      this.newTag.set('');
      if (res.skipped_existing) {
        // Nothing was stored: the tag already exists, as a manual tag or as an AI tag.
        this.snackBar.open(this.i18n.t(I18N.manual_tags.already_present), '', { duration: 3000 });
        return;
      }
      this.updateManualTags(p, tags => (tags.includes(res.tag) ? tags : [...tags, res.tag].sort()));
      this.journal.record('tags', [p.path], { action: 'add', tag: res.tag });
    } catch {
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  protected async removeManualTag(p: Photo, tag: string): Promise<void> {
    try {
      await firstValueFrom(this.api.delete('/photo/manual_tags', { path: p.path, tag }));
      this.updateManualTags(p, tags => tags.filter(t => t !== tag));
      this.journal.record('tags', [p.path], { action: 'remove', tag });
    } catch {
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  /** Applies `change` to the photo's manual tags as they are NOW, not as the caller captured them. */
  private updateManualTags(p: Photo, change: (tags: string[]) => string[]): void {
    const current = this.photo();
    if (current?.path === p.path) {
      this.applyConfirmed(current, { manual_tags: change(current.manual_tags) });
      return;
    }
    // The view moved on to another photo: keep the grid's row right without touching the signal.
    const row = this.store.photos().find(r => r.path === p.path);
    this.store.patchPhoto(p.path, { manual_tags: change(row?.manual_tags ?? p.manual_tags) });
  }

  protected editCaption(p: Photo): void {
    import('./caption-edit-dialog.component').then(m => {
      const ref = this.dialog.open(m.CaptionEditDialogComponent, {
        width: '95vw',
        maxWidth: '500px',
        data: { path: p.path, filename: p.filename, caption: p.caption || '' },
      });
      ref.afterClosed()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(result => {
          if (result !== undefined) {
            this.translatedCaption.set(null);
            this.applyConfirmed(p, { caption: result || null, caption_translated: undefined });
          }
        });
    });
  }

  protected openSimilar(photo: Photo, mode: 'visual' | 'color' | 'person'): void {
    this.router.navigate(['/'], {
      queryParams: { similar_to: photo.path, similarity_mode: mode, min_similarity: '70' },
    });
  }

  /** The header Analysis button and the tabs' "Why this score?" open the critique dialog, as in the gallery rail. */
  protected openCritique(photo: Photo): void {
    if (this.photo()?.path !== photo.path || this.router.currentNavigation?.()) return;
    this.photoActions.openCritique(photo);
  }

  protected async removeFromCatalog(): Promise<void> {
    const photo = this.photo();
    if (!photo?.is_rejected || photo.is_kept) return;
    const current = () => this.isCurrentViewer()
      && this.photo()?.path === photo.path && !!this.photo()?.is_rejected && !this.photo()?.is_kept;
    const removed = await this.photoActions.removeFromCatalog([photo.path], current);
    if (this.isCurrentViewer() && this.photo()?.path === photo.path && removed.includes(photo.path)) this.goBack();
  }

  /** Open the trash dialog with sibling and bracket-lead information from the loaded set. */
  protected deletePhoto(): void {
    const p = this.photo();
    if (!p?.is_rejected || p.is_kept) return;
    const set = this.photoSet();
    const hasSiblings = !!set?.kind && SEQUENCE_KINDS_KEPT_WHOLE.includes(set.kind) && set.count > 1;
    const hasBracketLead = set?.kind === 'bracket'
      && (set.members.find(m => m.path === p.path)?.is_lead ?? false);
    const current = () => this.isCurrentViewer()
      && this.photo()?.path === p.path && !!this.photo()?.is_rejected && !this.photo()?.is_kept;
    import('../../shared/components/photo-delete-dialog/photo-delete-dialog.component').then(m => {
      if (!current()) return;
      const ref = this.dialog.open(m.PhotoDeleteDialogComponent, {
        width: '95vw',
        maxWidth: '28rem',
        data: {
          surface: 'photo_detail',
          paths: [p.path],
          count: 1,
          hasCompanion: true,
          hasSiblings,
          hasBracketLead,
        },
      });
      ref.afterClosed()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(async result => {
        if (!result || !current()) return;
        const sameSession = captureSession(this.auth);
        const res = await this.photoActions.deletePhotos([p.path], result);
        if (!res || !sameSession()) return;
        // `removed_missing` counts as deleted for this surface: the row is
        // gone either way, which is all the photo page can observe.
        const gone = res.deleted.includes(p.path) || res.removed_missing.includes(p.path);
        if (gone) {
          this.store.removePhotos([p.path]);
          if (!this.isCurrentViewer() || this.photo()?.path !== p.path) return;
          this.snackBar.open(this.i18n.t(I18N.photo_detail.delete.success), '', { duration: 2000 });
          this.goBack();
        } else {
          if (!this.isCurrentViewer() || this.photo()?.path !== p.path) return;
          this.snackBar.open(this.i18n.t(I18N.photo_detail.delete.error), '', { duration: 3000 });
        }
      });
    });
  }

  protected openCategoryOverride(p: Photo): void {
    import('./category-override-dialog.component').then(m => {
      const ref = this.dialog.open(m.CategoryOverrideDialogComponent, {
        width: '95vw',
        maxWidth: '24rem',
        data: { path: p.path, currentCategory: p.category },
      });
      ref.afterClosed()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((result: CategoryOverrideResult | undefined) => {
          if (result) this.applyConfirmed(p, { category: result.category, aggregate: result.aggregate });
        });
    });
  }

  protected async clearCategoryOverride(p: Photo): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.api.post<{ new_category: string; aggregate: number }>('/comparison/clear_category_override', { path: p.path }),
      );
      this.applyConfirmed(p, { category: res.new_category, aggregate: res.aggregate });
      this.snackBar.open(this.i18n.t(I18N.photo.category_override.cleared), '', { duration: 3000 });
    } catch {
      this.snackBar.open(this.i18n.t(I18N.errors.action_failed), '', { duration: 3000 });
    }
  }

  protected loadExplainerCategories(): void {
    if (this.explainerCategories().length === 0) {
      this.explainerLoadFailed.set(false);
      firstValueFrom(this.api.get<{ categories: { name: string }[] }>('/config/category_priorities'))
        .then(res => this.explainerCategories.set(res.categories.map(c => c.name)))
        .catch(() => {
          // An empty dropdown with a disabled save gives the user nothing to
          // do: surface the failure with a retry instead.
          this.explainerLoadFailed.set(true);
        });
    }
  }

  protected async refreshPhoto(p: Photo): Promise<void> {
    const { current, dispose } = this.staleness.create(this.destroyRef, { valid: () => this.photo()?.path === p.path });
    try {
      const refreshed = await this.photoActions.refreshPhotos([p.path]);
      if (!current() || !refreshed.includes(p.path)) return;
      const photo = await this.fetchPhoto(p.path);
      if (current()) this.photo.set(photo);
    } finally { dispose(); }
  }

  protected openAddPerson(photo: Photo): void {
    this.photoActions.openAddPerson(photo, () => {
      this.photo.update(p => p?.path === photo.path ? { ...p, unassigned_faces: Math.max(0, p.unassigned_faces - 1) } : p);
    });
  }

  protected loadCaptureDateDialog() { return import('./capture-date-dialog.component'); }

  protected async editCaptureDate(p: Photo): Promise<void> {
    let opened = false;
    const { current, dispose } = this.staleness.create(this.destroyRef, { valid: () => this.photo()?.path === p.path });
    try {
      const m = await this.loadCaptureDateDialog();
      if (!current()) return;
      const data = { paths: [p.path], count: 1, manuallySet: p.date_manually_set === 1, reference: p.date_taken ? { path: p.path, date: p.date_taken } : null };
      const ref = this.dialog.open(m.CaptureDateDialogComponent, { width: '95vw', maxWidth: '760px', data });
      opened = true;
      ref.afterClosed().pipe(takeUntilDestroyed(this.destroyRef), finalize(dispose)).subscribe((result: import('./capture-date-dialog.component').CaptureDateResult | undefined) => {
        if (current() && result !== undefined) this.applyConfirmed(p, result);
      });
    } finally {
      if (!opened) dispose();
    }
  }

  protected loadGpsDialog() { return import('./gps-edit-dialog.component'); }

  protected async editGps(p: Photo): Promise<void> {
    let opened = false;
    const { current, dispose } = this.staleness.create(this.destroyRef, { valid: () => this.photo()?.path === p.path });
    try {
      const m = await this.loadGpsDialog();
      if (!current()) return;
      const ref = this.dialog.open(m.GpsEditDialogComponent, {
        width: '95vw',
        maxWidth: '640px',
        data: {
          path: p.path,
          filename: p.filename,
          lat: p.gps_latitude ?? null,
          lng: p.gps_longitude ?? null,
          manuallySet: p.gps_manually_set === 1,
        },
      });
      opened = true;
      ref.afterClosed().pipe(takeUntilDestroyed(this.destroyRef), finalize(dispose)).subscribe((result: { gps_latitude: number | null; gps_longitude: number | null; gps_manually_set?: number } | undefined) => {
        if (current() && result !== undefined) {
          this.applyConfirmed(p, { gps_latitude: result.gps_latitude, gps_longitude: result.gps_longitude, gps_manually_set: result.gps_manually_set ?? 1 });
          if (this.photo()?.path === p.path) this.locationName.set('');
        }
      });
    } finally {
      if (!opened) dispose();
    }
  }
}
