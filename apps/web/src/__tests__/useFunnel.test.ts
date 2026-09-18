// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tracking layer is mocked: this suite is about funnel state, and real
// beacons would make it a network test.
vi.mock('../tracking/index.js', () => ({
  trackEvent: vi.fn().mockResolvedValue({ eventId: 'evt_test', pixelFired: false, serverAccepted: true }),
  initTracking: vi.fn(),
  createConversionEventId: () => 'evt_test_conversion',
}));

import { useFunnel } from '../hooks/useFunnel.js';
import { trackEvent } from '../tracking/index.js';
import { STORAGE_KEYS, readStored } from '../lib/storage.js';

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(trackEvent).mockClear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useFunnel', () => {
  it('starts on the first question', () => {
    const { result } = renderHook(() => useFunnel());

    expect(result.current.question?.id).toBe('age_range');
    expect(result.current.stepNumber).toBe(1);
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.resumed).toBe(false);
  });

  it('advances through the funnel as questions are answered', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));
    expect(result.current.question?.id).toBe('receiving_benefits');
    expect(result.current.stepNumber).toBe(2);
    expect(result.current.answers.age_range).toBe('55_63');
  });

  it('skips the asset question for someone already receiving SSI', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));
    act(() => result.current.answer('ssi'));
    act(() => result.current.answer('not_working'));
    act(() => result.current.answer('over_6'));

    // asset_value is branched away; the next question is the duration test.
    expect(result.current.question?.id).toBe('out_of_work_year');
  });

  it('asks the asset question for someone with no benefits', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));
    act(() => result.current.answer('none'));
    act(() => result.current.answer('not_working'));
    act(() => result.current.answer('over_6'));

    expect(result.current.question?.id).toBe('asset_value');
  });

  it('goes back to the previous visible question', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));
    act(() => result.current.answer('none'));
    expect(result.current.question?.id).toBe('work_hours');

    act(() => result.current.goBack());
    expect(result.current.question?.id).toBe('receiving_benefits');
    expect(result.current.direction).toBe('back');
    // The answer is still there so the option shows as selected.
    expect(result.current.answers.receiving_benefits).toBe('none');
  });

  it('prunes orphaned answers when a branch is closed from the back button', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63')); // age_range
    act(() => result.current.answer('none')); // receiving_benefits
    act(() => result.current.answer('not_working')); // work_hours
    act(() => result.current.answer('over_6')); // years_employed
    act(() => result.current.answer('under_2000')); // asset_value
    act(() => result.current.answer('yes')); // out_of_work_year
    act(() => result.current.answer('yes')); // under_medical_care
    act(() => result.current.answer('yes')); // application_pending -> opens branch
    act(() => result.current.answer('yes')); // attorney_represented
    act(() => result.current.answer('allsup')); // attorney_firm

    expect(result.current.answers.attorney_firm).toBe('allsup');

    // Walk back to application_pending and flip it.
    act(() => result.current.goBack()); // attorney_firm
    act(() => result.current.goBack()); // attorney_represented
    act(() => result.current.goBack()); // application_pending
    expect(result.current.question?.id).toBe('application_pending');

    act(() => result.current.answer('no'));

    // The whole attorney branch is gone - it would otherwise be stored as fact.
    expect(result.current.answers.attorney_represented).toBeUndefined();
    expect(result.current.answers.attorney_firm).toBeUndefined();
    expect(result.current.question?.id).toBe('gender');
  });

  it('rejects an answer that fails validation', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer(''));

    expect(result.current.error).toBeTruthy();
    // Still on the same question.
    expect(result.current.question?.id).toBe('age_range');
  });

  it('autosaves progress to storage after each answer', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('50_54'));

    const saved = readStored<{ answers: Record<string, string>; currentQuestionId: string }>(
      STORAGE_KEYS.progress,
    );
    expect(saved?.answers.age_range).toBe('50_54');
    expect(saved?.currentQuestionId).toBe('receiving_benefits');
  });

  it('resumes from saved progress after a refresh', () => {
    const first = renderHook(() => useFunnel());
    act(() => first.result.current.answer('50_54'));
    act(() => first.result.current.answer('none'));
    first.unmount();

    // Simulates the user reloading the page.
    const second = renderHook(() => useFunnel());

    expect(second.result.current.resumed).toBe(true);
    expect(second.result.current.question?.id).toBe('work_hours');
    expect(second.result.current.answers.age_range).toBe('50_54');
  });

  it('clears everything on reset', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('50_54'));
    act(() => result.current.reset());

    expect(result.current.question?.id).toBe('age_range');
    expect(result.current.answers).toEqual({});

    // Autosave immediately re-persists the fresh, empty state - which must not
    // be mistaken for a resumable session.
    const saved = readStored<{ answers: Record<string, string> }>(STORAGE_KEYS.progress);
    expect(saved?.answers ?? {}).toEqual({});
  });

  it('does not report a freshly reset funnel as resumed', () => {
    const first = renderHook(() => useFunnel());
    act(() => first.result.current.answer('50_54'));
    act(() => first.result.current.reset());
    first.unmount();

    const second = renderHook(() => useFunnel());
    expect(second.result.current.resumed).toBe(false);
    expect(second.result.current.question?.id).toBe('age_range');
  });

  it('emits QualificationStarted once when the first question renders', () => {
    const { result } = renderHook(() => useFunnel());

    const started = vi
      .mocked(trackEvent)
      .mock.calls.filter(([input]) => input.eventName === 'QualificationStarted');
    expect(started).toHaveLength(1);

    // Answering must not fire it a second time.
    act(() => result.current.answer('55_63'));
    expect(
      vi.mocked(trackEvent).mock.calls.filter(
        ([input]) => input.eventName === 'QualificationStarted',
      ),
    ).toHaveLength(1);
  });

  it('emits FunnelStarted exactly once', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));
    act(() => result.current.answer('none'));
    act(() => result.current.answer('not_working'));

    const started = vi
      .mocked(trackEvent)
      .mock.calls.filter(([input]) => input.eventName === 'FunnelStarted');
    expect(started).toHaveLength(1);
  });

  it('emits QuestionCompleted with the id and step but never the answer', () => {
    const { result } = renderHook(() => useFunnel());

    act(() => result.current.answer('55_63'));

    const call = vi
      .mocked(trackEvent)
      .mock.calls.find(([input]) => input.eventName === 'QuestionCompleted');

    expect(call?.[0].questionId).toBe('age_range');
    expect(call?.[0].stepNumber).toBe(1);
    // The answer value is nowhere in the payload.
    expect(JSON.stringify(call?.[0])).not.toContain('55_63');
  });

  it('reports a shorter path when a branch is skipped', () => {
    const skipped = renderHook(() => useFunnel());
    act(() => skipped.result.current.answer('55_63'));
    act(() => skipped.result.current.answer('ssi'));
    const skippedTotal = skipped.result.current.totalSteps;
    skipped.unmount();

    window.localStorage.clear();

    const full = renderHook(() => useFunnel());
    act(() => full.result.current.answer('55_63'));
    act(() => full.result.current.answer('none'));
    const fullTotal = full.result.current.totalSteps;

    expect(fullTotal).toBeGreaterThan(skippedTotal);
  });
});
