/**
 * Calendar source — reads the generated content-calendar.yaml and picks
 * the best unpublished topic for the next pipeline run.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

interface CalendarTopic {
  keyword: string;
  volume: number;
  kd: number;
  traffic_potential: number;
  cpc: number | null;
  score: number;
  published: boolean;
}

interface CalendarPillar {
  pillar: string;
  vertical: string;
  product_page: string;
  topics: CalendarTopic[];
}

interface CalendarFile {
  pillars: CalendarPillar[];
}

export function loadCalendar(): CalendarFile | null {
  const calPath = path.join(process.cwd(), 'config', 'content-calendar.yaml');
  if (!fs.existsSync(calPath)) return null;
  const raw = fs.readFileSync(calPath, 'utf-8');
  return YAML.parse(raw) as CalendarFile;
}

export function pickCalendarTopic(): (CalendarTopic & { vertical: string; productPage: string; pillar: string }) | null {
  const cal = loadCalendar();
  if (!cal) return null;

  let best: (CalendarTopic & { vertical: string; productPage: string; pillar: string }) | null = null;

  for (const pillar of cal.pillars) {
    for (const topic of pillar.topics) {
      if (topic.published) continue;
      if (!best || topic.score > best.score) {
        best = {
          ...topic,
          vertical: pillar.vertical,
          productPage: pillar.product_page,
          pillar: pillar.pillar,
        };
      }
    }
  }

  return best;
}
