import { I18N } from '../../core/i18n/keys';
import { CaptureDatePipe } from '../../shared/pipes/capture-date.pipe';
import { isUnavailableKey, unavailableSet } from '../../shared/utils/unavailable-metrics';
import { folderDisplayName } from '../folders/folders.util';
import type { GalleryStore } from './gallery.store';
import { parseScorePresence } from './score-presence.util';
import { parseTagQuery, TAG_QUERY_GROUPS } from './tag-query.util';

/** One active filter of the gallery's collection, as the criteria row and the photo page's View panel show it. */
export interface GalleryFilterChip { id: string; labelKey: string; value: string; clearKeys: string[]; personId?: number }

/** Min/max filter pairs shown as one chip each. */
export const RANGE_CHIPS: readonly { minKey: string; maxKey: string; labelKey: string }[] = [
  { minKey: 'min_score', maxKey: 'max_score', labelKey: 'gallery.score_range' },
  { minKey: 'min_aesthetic', maxKey: 'max_aesthetic', labelKey: 'gallery.aesthetic_range' },
  { minKey: 'min_quality_score', maxKey: 'max_quality_score', labelKey: 'gallery.quality_score_range' },
  { minKey: 'min_topiq', maxKey: 'max_topiq', labelKey: 'gallery.topiq_range' },
  { minKey: 'min_face_quality', maxKey: 'max_face_quality', labelKey: 'gallery.face_quality_range' },
  { minKey: 'min_eye_sharpness', maxKey: 'max_eye_sharpness', labelKey: 'gallery.eye_sharpness_range' },
  { minKey: 'min_face_sharpness', maxKey: 'max_face_sharpness', labelKey: 'gallery.face_sharpness_range' },
  { minKey: 'min_face_ratio', maxKey: 'max_face_ratio', labelKey: 'gallery.face_ratio_range' },
  { minKey: 'min_face_count', maxKey: 'max_face_count', labelKey: 'gallery.face_count_range' },
  { minKey: 'min_face_confidence', maxKey: 'max_face_confidence', labelKey: 'gallery.face_confidence_range' },
  { minKey: 'min_composition', maxKey: 'max_composition', labelKey: 'gallery.composition_range' },
  { minKey: 'min_sharpness', maxKey: 'max_sharpness', labelKey: 'gallery.sharpness_range' },
  { minKey: 'min_exposure', maxKey: 'max_exposure', labelKey: 'gallery.exposure_range' },
  { minKey: 'min_color', maxKey: 'max_color', labelKey: 'gallery.color_range' },
  { minKey: 'min_contrast', maxKey: 'max_contrast', labelKey: 'gallery.contrast_range' },
  { minKey: 'min_noise', maxKey: 'max_noise', labelKey: 'gallery.noise_range' },
  { minKey: 'min_dynamic_range', maxKey: 'max_dynamic_range', labelKey: 'gallery.dynamic_range' },
  { minKey: 'min_saturation', maxKey: 'max_saturation', labelKey: 'gallery.saturation_range' },
  { minKey: 'min_luminance', maxKey: 'max_luminance', labelKey: 'gallery.luminance_range' },
  { minKey: 'min_histogram_spread', maxKey: 'max_histogram_spread', labelKey: 'gallery.histogram_range' },
  { minKey: 'min_power_point', maxKey: 'max_power_point', labelKey: 'gallery.power_point_range' },
  { minKey: 'min_leading_lines', maxKey: 'max_leading_lines', labelKey: 'gallery.leading_lines_range' },
  { minKey: 'min_isolation', maxKey: 'max_isolation', labelKey: 'gallery.isolation_range' },
  { minKey: 'min_aesthetic_iaa', maxKey: 'max_aesthetic_iaa', labelKey: 'gallery.aesthetic_iaa_range' },
  { minKey: 'min_face_quality_iqa', maxKey: 'max_face_quality_iqa', labelKey: 'gallery.face_quality_iqa_range' },
  { minKey: 'min_liqe', maxKey: 'max_liqe', labelKey: 'gallery.liqe_range' },
  { minKey: 'min_qrealign', maxKey: 'max_qrealign', labelKey: 'gallery.qrealign_range' },
  { minKey: 'min_aesthetic_v25', maxKey: 'max_aesthetic_v25', labelKey: 'gallery.aesthetic_v25_range' },
  { minKey: 'min_deqa', maxKey: 'max_deqa', labelKey: 'gallery.deqa_range' },
  { minKey: 'min_subject_sharpness', maxKey: 'max_subject_sharpness', labelKey: 'gallery.subject_sharpness_range' },
  { minKey: 'min_subject_prominence', maxKey: 'max_subject_prominence', labelKey: 'gallery.subject_prominence_range' },
  { minKey: 'min_subject_placement', maxKey: 'max_subject_placement', labelKey: 'gallery.subject_placement_range' },
  { minKey: 'min_bg_separation', maxKey: 'max_bg_separation', labelKey: 'gallery.bg_separation_range' },
  { minKey: 'min_moment_confidence', maxKey: 'max_moment_confidence', labelKey: 'gallery.moment_confidence_range' },
  { minKey: 'min_star_rating', maxKey: 'max_star_rating', labelKey: 'gallery.star_rating_range' },
  { minKey: 'min_iso', maxKey: 'max_iso', labelKey: 'gallery.iso_range' },
  { minKey: 'min_aperture', maxKey: 'max_aperture', labelKey: 'gallery.aperture_range' },
  { minKey: 'min_focal_length', maxKey: 'max_focal_length', labelKey: 'gallery.focal_range' },
  { minKey: 'date_from', maxKey: 'date_to', labelKey: 'gallery.sidebar.date' },
  { minKey: 'min_channel_clip_shadow', maxKey: 'max_channel_clip_shadow', labelKey: 'gallery.channel_clip_shadow_range' },
  { minKey: 'min_channel_clip_highlight', maxKey: 'max_channel_clip_highlight', labelKey: 'gallery.channel_clip_highlight_range' },
];

const date = new CaptureDatePipe();

/** The filters that define a collection, beside its name: an album chip is the name, not one of them. */
export function definingFilters(chips: readonly GalleryFilterChip[]): GalleryFilterChip[] {
  return chips.filter(chip => chip.id !== 'album');
}

/** The collection's active filters as labelled chips (`t` translates a chip value); the criteria row makes them removable. */
export function galleryFilterChips(store: GalleryStore, t: (key: string) => string): GalleryFilterChip[] {
  const f = store.filters();
  const chips: GalleryFilterChip[] = [];

  // Album filter
  if (f.album_id) {
    const album = store.currentAlbum();
    const name = album?.name || `#${f.album_id}`;
    chips.push({ id: 'album', labelKey: 'nav.albums', value: name, clearKeys: ['album_id'] });
  }

  // Semantic search
  if (f.semanticQuery) chips.push({ id: 'semanticQuery', labelKey: 'gallery.semantic_search_chip', value: f.semanticQuery, clearKeys: ['semanticQuery'] });
  if (f.semanticQuery && f.search_threshold) chips.push({ id: 'search_threshold', labelKey: I18N.gallery.semantic_search_threshold, value: `${f.search_threshold}%`, clearKeys: ['search_threshold'] });
  if (f.type) chips.push({ id: 'type', labelKey: I18N.ui.filters.type, value: t(f.type === 'top_picks' ? 'photo_types.top_picks' : 'category_names.' + f.type), clearKeys: ['type'] });
  if (f.review_status) chips.push({ id: 'review_status', labelKey: I18N.gallery.sidebar.review.decision, value: t('gallery.sidebar.review.values.' + f.review_status), clearKeys: ['review_status'] });
  if (f.sequence_override) chips.push({ id: 'sequence_override', labelKey: I18N.gallery.sequence_override.label, value: t('gallery.sequence_override.' + f.sequence_override), clearKeys: ['sequence_override'] });
  if (f.no_gps) chips.push({ id: 'no_gps', labelKey: I18N.gallery.sidebar.location, value: t(I18N.gallery.criteria.no_location), clearKeys: ['no_gps'] });
  if (f.no_capture_date) chips.push({ id: 'no_capture_date', labelKey: I18N.gallery.sidebar.date, value: t(I18N.gallery.no_capture_date), clearKeys: ['no_capture_date'] });
  const scorePolicies = parseScorePresence(f.score_presence ?? '');
  if (f.score_presence) {
    const value = scorePolicies ? Object.entries(scorePolicies).map(([key, mode]) => {
      const metric = RANGE_CHIPS.find(row => row.minKey === key);
      return `${t(metric?.labelKey ?? key)}: ${t(I18N.gallery.measurements[mode])}`;
    }).join('; ') : t(I18N.gallery.measurements.invalid);
    chips.push({ id: 'score_presence', labelKey: I18N.gallery.measurements.title, value, clearKeys: ['score_presence'] });
  }

  // Simple string/select filters
  if (f.tag) chips.push({ id: 'tag', labelKey: 'gallery.tag', value: f.tag, clearKeys: ['tag'] });
  if (f.keyword_branch) chips.push({ id: 'keyword_branch', labelKey: I18N.keyword_hierarchy.title,
    value: f.keyword_branch, clearKeys: ['keyword_branch'] });
  if (f.tag_groups) {
    const groups = parseTagQuery(f.tag_groups);
    const value = groups ? TAG_QUERY_GROUPS.filter(key => groups[key].length).map(key => `${t(I18N.gallery.tag_groups[key])}: ${groups[key].map(tag => JSON.stringify(tag)).join(', ')}`).join('; ') : t(I18N.gallery.tag_groups.invalid);
    if (value) chips.push({ id: 'tag_groups', labelKey: I18N.gallery.tag_groups.title, value, clearKeys: ['tag_groups'] });
  }

  if (f.search) chips.push({ id: 'search', labelKey: 'gallery.search_chip', value: f.search, clearKeys: ['search'] });
  if (f.camera) chips.push({ id: 'camera', labelKey: 'gallery.camera', value: f.camera, clearKeys: ['camera'] });
  if (f.lens) chips.push({ id: 'lens', labelKey: 'gallery.lens', value: f.lens, clearKeys: ['lens'] });
  if (f.composition_pattern) chips.push({ id: 'composition_pattern', labelKey: 'gallery.composition_pattern', value: f.composition_pattern, clearKeys: ['composition_pattern'] });
  if (f.quality_tier) chips.push({ id: 'quality_tier', labelKey: 'gallery.quality_tier', value: t('gallery.quality_tiers.' + f.quality_tier), clearKeys: ['quality_tier'] });
  if (f.color_temp) chips.push({ id: 'color_temp', labelKey: 'gallery.color_temp', value: t('gallery.color_temps.' + f.color_temp), clearKeys: ['color_temp'] });
  if (f.hue_bucket) chips.push({ id: 'hue_bucket', labelKey: 'gallery.hue', value: t('gallery.hue_buckets.' + f.hue_bucket), clearKeys: ['hue_bucket'] });
  if (f.path_prefix) chips.push({ id: 'path_prefix', labelKey: 'folders.title', value: folderDisplayName(f.path_prefix), clearKeys: ['path_prefix'] });

  // Person filter — one chip per selected person
  if (f.person_id) {
    const ids = f.person_id.split(',').filter(Boolean);
    for (const pid of ids) {
      const person = store.persons().find(p => String(p.id) === pid);
      const name = person?.name || `#${pid}`;
      chips.push({ id: `person_${pid}`, labelKey: 'gallery.person', value: name, clearKeys: [`person_${pid}`], personId: Number(pid) });
    }
  }

  // GPS location filter
  if (f.gps_lat && f.gps_lng) {
    const locationName = store.gpsLocationName() || `${(+f.gps_lat).toFixed(2)}, ${(+f.gps_lng).toFixed(2)}`;
    const radius = f.gps_radius_km ? ` — ${f.gps_radius_km} km` : '';
    chips.push({ id: 'gps', labelKey: 'gallery.sidebar.location', value: locationName + radius, clearKeys: ['gps_lat', 'gps_lng', 'gps_radius_km'] });
  }

  // Boolean filters
  if (f.favorites_only) chips.push({ id: 'favorites_only', labelKey: 'gallery.favorites_only', value: '', clearKeys: ['favorites_only'] });
  if (f.is_monochrome) chips.push({ id: 'is_monochrome', labelKey: 'gallery.monochrome_only', value: '', clearKeys: ['is_monochrome'] });
  if (f.manual_faces_need_review) chips.push({ id: 'manual_faces_need_review', labelKey: I18N.gallery.manual_faces_need_review, value: '', clearKeys: ['manual_faces_need_review'] });
  for (const [key, labelKey] of [
    ['show_rejected', I18N.gallery.sidebar.review.values.only_rejected],
    ['blinks_only', I18N.gallery.criteria.field_labels.blinks_only],
    ['duplicates_only', I18N.gallery.criteria.field_labels.duplicates_only],
    ['faces_need_names', I18N.gallery.faces_need_names],
  ] as const) if (f[key]) chips.push({ id: key, labelKey, value: '', clearKeys: [key] });

  // Range/date filter pairs (metrics hidden by the licensing policy get no chip)
  const hiddenMetrics = unavailableSet(store.config()?.unavailable_metrics);
  for (const { minKey, maxKey, labelKey } of RANGE_CHIPS) {
    if (isUnavailableKey(minKey, hiddenMetrics)) continue;
    if (scorePolicies?.[minKey] === 'missing_only') continue;
    const rawMin = (f as unknown as Record<string, string>)[minKey];
    const rawMax = (f as unknown as Record<string, string>)[maxKey];
    const min = minKey === 'date_from' ? date.transform(rawMin) : rawMin;
    const max = maxKey === 'date_to' ? date.transform(rawMax) : rawMax;
    if (min || max) {
      const value = (min && max) ? `${min}–${max}` : min ? `≥${min}` : `≤${max}`;
      chips.push({ id: minKey, labelKey, value, clearKeys: [minKey, maxKey] });
    }
  }

  return chips;
}
