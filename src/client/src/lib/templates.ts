export type FocusMode = 'flash' | 'balanced' | 'thorough' | 'image'

export interface TemplateField {
  id: string
  label: string
  placeholder: string
  required: boolean
  multiline?: boolean
  type?: 'text' | 'select' | 'toggle'
  options?: string[]
  defaultValue?: string
}

export interface Template {
  id: string
  name: string
  description: string
  suggestedMode: FocusMode
  fields: TemplateField[]
  assemble(values: Record<string, string>): string
}

export const TEMPLATES: Template[] = [
  {
    id: 'research',
    name: 'Research deep-dive',
    description: 'Structured research with a specific angle and output format',
    suggestedMode: 'thorough',
    fields: [
      {
        id: 'role',
        label: 'Your expert role',
        placeholder: 'e.g. academic researcher, science journalist, industry analyst',
        required: false,
      },
      {
        id: 'topic',
        label: 'Topic',
        placeholder: 'e.g. advances in mRNA vaccine technology',
        required: true,
      },
      {
        id: 'angle',
        label: 'Focus angle',
        placeholder: 'e.g. recent breakthroughs and remaining challenges',
        required: true,
      },
      {
        id: 'format',
        label: 'Output format',
        placeholder: '',
        required: false,
        type: 'select',
        options: ['structured report', 'bullet summary', 'executive summary'],
        defaultValue: 'structured report',
      },
    ],
    assemble(v) {
      const role = v.role?.trim() ? `Act as a ${v.role.trim()}. ` : ''
      const format = v.format?.trim() ? ` Write a ${v.format.trim()}.` : ''
      return `${role}Research ${v.topic.trim()}, focusing specifically on ${v.angle.trim()}.${format}`
    },
  },
  {
    id: 'compare',
    name: 'Compare & Analyze',
    description: 'Side-by-side comparison with a recommendation',
    suggestedMode: 'balanced',
    fields: [
      {
        id: 'role',
        label: 'Your expert role',
        placeholder: 'e.g. technology consultant, financial analyst',
        required: false,
      },
      {
        id: 'subjectA',
        label: 'Subject A',
        placeholder: 'e.g. PostgreSQL',
        required: true,
      },
      {
        id: 'subjectB',
        label: 'Subject B',
        placeholder: 'e.g. MySQL',
        required: true,
      },
      {
        id: 'criteria',
        label: 'Criteria',
        placeholder: 'e.g. performance, scalability, ease of use',
        required: true,
      },
    ],
    assemble(v) {
      const role = v.role?.trim() ? `Act as a ${v.role.trim()}. ` : ''
      return `${role}Compare ${v.subjectA.trim()} and ${v.subjectB.trim()} on the following criteria: ${v.criteria.trim()}. Present a side-by-side analysis with pros, cons, and a recommendation.`
    },
  },
  {
    id: 'explain',
    name: 'Explain / Teach',
    description: 'Concept explanation tailored to a specific audience',
    suggestedMode: 'flash',
    fields: [
      {
        id: 'role',
        label: 'Your expert role',
        placeholder: 'e.g. expert teacher, senior engineer',
        required: false,
      },
      {
        id: 'concept',
        label: 'Concept',
        placeholder: 'e.g. recursion, neural networks, compound interest',
        required: true,
      },
      {
        id: 'audience',
        label: 'Audience',
        placeholder: 'e.g. a complete beginner, an experienced developer, a non-technical manager',
        required: true,
      },
      {
        id: 'examples',
        label: 'Include examples?',
        placeholder: '',
        required: false,
        type: 'toggle',
        defaultValue: 'true',
      },
    ],
    assemble(v) {
      const role = v.role?.trim() ? `Act as a ${v.role.trim()}. ` : ''
      const examples = v.examples !== 'false' ? ' Use concrete examples.' : ''
      return `${role}Explain ${v.concept.trim()} to ${v.audience.trim()}.${examples}`
    },
  },
  {
    id: 'news',
    name: 'Latest news on',
    description: 'Current developments on a topic with implications',
    suggestedMode: 'balanced',
    fields: [
      {
        id: 'role',
        label: 'Your expert role',
        placeholder: 'e.g. investigative journalist, market analyst',
        required: false,
      },
      {
        id: 'topic',
        label: 'Topic',
        placeholder: 'e.g. AI regulation in the EU',
        required: true,
      },
      {
        id: 'timeRange',
        label: 'Time range',
        placeholder: 'e.g. last week, last month',
        required: false,
      },
      {
        id: 'region',
        label: 'Region',
        placeholder: 'e.g. United States, Europe',
        required: false,
      },
    ],
    assemble(v) {
      const role = v.role?.trim() ? `Act as a ${v.role.trim()}. ` : ''
      const time = v.timeRange?.trim() ? ` in the last ${v.timeRange.trim()}` : ''
      const region = v.region?.trim() ? ` in ${v.region.trim()}` : ''
      return `${role}What are the latest developments on ${v.topic.trim()}${time}${region}? Summarize key events and their implications.`
    },
  },
  {
    id: 'draw-image',
    name: 'Draw / Illustrate',
    description: 'Generate an image with a local diffusion model',
    suggestedMode: 'image',
    fields: [
      {
        id: 'subject',
        label: 'Subject',
        placeholder: 'e.g. a red fox sitting in a snowy forest',
        required: true,
      },
      {
        id: 'style',
        label: 'Style',
        placeholder: '',
        required: false,
        type: 'select',
        options: ['photorealistic', 'cinematic', 'anime', 'oil painting', 'watercolor', 'sketch', 'digital art'],
        defaultValue: 'photorealistic',
      },
      {
        id: 'lighting',
        label: 'Lighting',
        placeholder: '',
        required: false,
        type: 'select',
        options: ['natural', 'golden hour', 'studio', 'dramatic', 'neon'],
        defaultValue: 'natural',
      },
      {
        id: 'resolution',
        label: 'Resolution',
        placeholder: '',
        required: false,
        type: 'select',
        options: ['512x512', '768x768', '1024x1024', '1024x576'],
        defaultValue: '512x512',
      },
      {
        id: 'quality',
        label: 'Quality',
        placeholder: '',
        required: false,
        type: 'select',
        options: ['draft (fast, ~15 steps)', 'balanced (~25 steps)', 'high (~40 steps)'],
        defaultValue: 'balanced (~25 steps)',
      },
      {
        id: 'negative',
        label: 'Avoid (optional)',
        placeholder: 'e.g. blurry, low quality, text, watermark',
        required: false,
      },
    ],
    assemble(v) {
      const parts = [`Generate an image of ${v.subject.trim()}.`]
      if (v.style) parts.push(`Style: ${v.style}.`)
      if (v.lighting) parts.push(`Lighting: ${v.lighting}.`)
      if (v.resolution) parts.push(`Resolution: ${v.resolution}.`)
      if (v.quality) parts.push(`Quality: ${v.quality}.`)
      if (v.negative?.trim()) parts.push(`Avoid: ${v.negative.trim()}.`)
      return parts.join(' ')
    },
  },
]
