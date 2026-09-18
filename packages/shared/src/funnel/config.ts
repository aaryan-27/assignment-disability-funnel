import type { FunnelConfig } from './types.js';

/**
 * The funnel definition.
 *
 * Ordering note: unlike the reference funnel we ask the age range up front.
 * Age is the single strongest qualification signal for SSDI/SSI, it is cheap to
 * answer, and asking it first means we stop spending a user's patience on 14
 * more questions when the outcome is already decided.
 *
 * Sensitivity note: every disability / medical / financial question is tagged
 * `sensitive`. The tracking layer refuses to forward sensitive answers to any
 * third party — see `packages/shared/src/events.ts`.
 */
export const FUNNEL_VERSION = 'qualification-v1';

export const funnelConfig: FunnelConfig = {
  version: FUNNEL_VERSION,
  intro: {
    headline: 'Over 50 and Unable to Work?',
    subheadline: 'You may be eligible for up to {amount} every month in disability benefits.',
    benefitAmount: '$4,152',
  },
  questions: [
    {
      id: 'age_range',
      type: 'single_select',
      question: 'What is your age range?',
      description: 'Age is one of the biggest factors in a disability award.',
      sensitivity: 'standard',
      options: [
        { value: 'under_40', label: 'Under 40' },
        { value: '40_49', label: '40 - 49' },
        { value: '50_54', label: '50 - 54' },
        { value: '55_63', label: '55 - 63' },
        { value: '64_plus', label: '64 or older' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'receiving_benefits',
      type: 'single_select',
      question: 'Which disability benefits are you currently receiving?',
      sensitivity: 'sensitive',
      options: [
        { value: 'ssd', label: 'Social Security Disability (SSD)' },
        { value: 'ssi', label: 'Supplemental Security Income (SSI)' },
        { value: 'both', label: 'Both SSD and SSI' },
        { value: 'none', label: 'I am not receiving any disability benefits' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'work_hours',
      type: 'single_select',
      question: 'How many hours per week are you currently working?',
      sensitivity: 'sensitive',
      options: [
        { value: 'not_working', label: 'Not working' },
        { value: 'under_20', label: '20 hours or less per week' },
        { value: 'over_20', label: 'More than 20 hours per week' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'years_employed',
      type: 'single_select',
      question: 'In the past 10 years, how many years have you been employed?',
      description: 'Work history determines your SSD work credits.',
      sensitivity: 'sensitive',
      options: [
        { value: 'under_2', label: 'Less than 2 years' },
        { value: '2_to_4', label: 'Between 2 and 4 years' },
        { value: '4_to_6', label: 'Between 4 and 6 years' },
        { value: 'over_6', label: 'More than 6 years' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      // Branch: the asset test only exists for the means-tested SSI programme.
      // Anyone already receiving SSI has passed it already - do not re-ask.
      id: 'asset_value',
      type: 'single_select',
      question: 'What is the total value of your assets?',
      description: 'Do not include your house or your car.',
      sensitivity: 'sensitive',
      showIf: [{ questionId: 'receiving_benefits', operator: 'not_in', value: ['ssi', 'both'] }],
      options: [
        { value: 'under_2000', label: 'Less than $2,000' },
        { value: 'over_2000', label: 'More than $2,000' },
        { value: 'not_sure', label: 'Not sure' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'out_of_work_year',
      type: 'single_select',
      layout: 'binary',
      question: 'Do you expect to be out of work for at least a year due to a disability?',
      sensitivity: 'sensitive',
      options: [
        { value: 'yes', label: 'Yes', icon: 'check' },
        { value: 'no', label: 'No', icon: 'cross' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'under_medical_care',
      type: 'single_select',
      layout: 'binary',
      question: 'Are you currently seeing a doctor or taking prescribed medication for a disability?',
      sensitivity: 'sensitive',
      options: [
        { value: 'yes', label: 'Yes', icon: 'check' },
        { value: 'no', label: 'No', icon: 'cross' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'application_pending',
      type: 'single_select',
      layout: 'binary',
      question: 'Do you have a pending application for Social Security Disability (SSD) benefits?',
      sensitivity: 'sensitive',
      options: [
        { value: 'yes', label: 'Yes', icon: 'check' },
        { value: 'no', label: 'No', icon: 'cross' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      // Branch family A: everything below only matters to an existing applicant.
      id: 'attorney_represented',
      type: 'single_select',
      layout: 'binary',
      question: 'Is an attorney or advocate currently representing you for this SSD application?',
      sensitivity: 'standard',
      showIf: [{ questionId: 'application_pending', operator: 'equals', value: 'yes' }],
      options: [
        { value: 'yes', label: 'Yes', icon: 'check' },
        { value: 'no', label: 'No', icon: 'cross' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      // Nested branch: only asked when represented. Drives routing - a lead that
      // already has representation is a different (lower value) lead type.
      id: 'attorney_firm',
      type: 'single_select',
      question: 'Which firm is currently helping you with your disability application?',
      sensitivity: 'standard',
      showIf: [{ questionId: 'attorney_represented', operator: 'equals', value: 'yes' }],
      options: [
        { value: 'trajector', label: 'Trajector Disability' },
        { value: 'premier', label: 'Premier Disability' },
        { value: 'citizens', label: 'Citizens Disability' },
        { value: 'nyman_turkish', label: 'Nyman Turkish PC' },
        { value: 'allsup', label: 'Allsup' },
        { value: 'other', label: 'Another firm' },
        { value: 'unsure', label: "I'm not sure" },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'application_denied',
      type: 'single_select',
      layout: 'binary',
      question: 'Was your disability application denied?',
      sensitivity: 'sensitive',
      showIf: [{ questionId: 'application_pending', operator: 'equals', value: 'yes' }],
      options: [
        { value: 'yes', label: 'Yes', icon: 'check' },
        { value: 'no', label: 'No', icon: 'cross' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      // Nested branch: appeal stage only exists after a denial.
      id: 'appeal_stage',
      type: 'single_select',
      question: 'Where are you in the process?',
      sensitivity: 'sensitive',
      showIf: [{ questionId: 'application_denied', operator: 'equals', value: 'yes' }],
      options: [
        { value: 'waiting_first', label: 'Waiting on first decision' },
        { value: 'first_denied', label: 'First decision was denied' },
        { value: 'reconsideration', label: 'I requested reconsideration' },
        { value: 'hearing', label: 'I requested a hearing' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'waiting_duration',
      type: 'single_select',
      question: 'How long have you been waiting?',
      sensitivity: 'standard',
      showIf: [{ questionId: 'application_pending', operator: 'equals', value: 'yes' }],
      options: [
        { value: 'under_3m', label: 'Less than 3 months' },
        { value: '3_to_6m', label: '3 - 6 months' },
        { value: '6_to_9m', label: '6 - 9 months' },
        { value: 'over_9m', label: 'More than 9 months' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'gender',
      type: 'single_select',
      question: 'How do you identify your gender?',
      sensitivity: 'identity',
      options: [
        { value: 'male', label: 'Male' },
        { value: 'female', label: 'Female' },
        { value: 'non_binary', label: 'Non-binary' },
        { value: 'undisclosed', label: 'Prefer not to respond' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'marital_status',
      type: 'single_select',
      question: 'What is your current marital status?',
      sensitivity: 'standard',
      options: [
        { value: 'single', label: 'Single' },
        { value: 'married', label: 'Married' },
        { value: 'widowed', label: 'Widowed' },
        { value: 'divorced', label: 'Divorced' },
        { value: 'separated', label: 'Separated (not receiving support)' },
      ],
      validation: [{ type: 'required' }],
    },
    {
      id: 'email',
      type: 'email',
      question: 'Where should we send your results?',
      description: 'We email your qualification summary so you always have a copy.',
      sensitivity: 'identity',
      ctaLabel: 'Send My Results',
      validation: [{ type: 'required', message: 'Enter your email address' }, { type: 'email' }],
    },
    {
      id: 'contact',
      type: 'contact',
      question: 'Last step - where can a specialist reach you?',
      description: 'A benefits specialist reviews your answers and calls with next steps.',
      sensitivity: 'identity',
      ctaLabel: 'See What I Qualify For',
      hideFromProgress: false,
      validation: [{ type: 'required' }],
    },
  ],
};

/**
 * Steps that capture identity rather than qualification detail.
 *
 * These are excluded from the Qualification answers table: they already exist
 * as first-class columns on the lead, and duplicating PII into the table that
 * holds health answers would widen the blast radius of that table for no gain.
 */
export const CONTACT_STEP_IDS: readonly string[] = ['email', 'contact'];
