const BUFFER_MAX = 4096;
const PLAN_NAME_RE = /[a-z]+-[a-z]+(?:-[a-z]+){0,3}/;
const PLAN_NAME_EXACT = /^[a-z]+-[a-z]+(?:-[a-z]+){0,3}$/;

// Blue ANSI 256-color codes
const BLUE_256_CODES = new Set([4, 12, 27, 33, 39, 63, 69, 75, 81]);

// Strip all ANSI escape sequences: CSI, OSC, and simple escapes
const ANSI_RE = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][AB012]|[=>NOM78Hc])/g;

export class PlanDetector {
  private detectedPlans = new Map<string, string>();
  private userRenamed = new Map<string, boolean>();
  private callback: ((sessionId: string, planName: string) => void) | null = null;
  private buffers = new Map<string, string>();
  private debug = process.env.TETHER_DEBUG_PLAN_DETECT === '1';

  onPlanDetected(callback: (sessionId: string, planName: string) => void): void {
    this.callback = callback;
  }

  register(sessionId: string): void {
    this.buffers.set(sessionId, '');
  }

  unregister(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.detectedPlans.delete(sessionId);
    this.userRenamed.delete(sessionId);
  }

  feedData(sessionId: string, rawData: string): void {
    if (this.userRenamed.get(sessionId)) return;

    let buffer = (this.buffers.get(sessionId) || '') + rawData;
    if (buffer.length > BUFFER_MAX) {
      buffer = buffer.slice(buffer.length - BUFFER_MAX);
    }
    this.buffers.set(sessionId, buffer);

    // Layer 1: colored ANSI text (blue variants)
    let planName = this.extractFromColoredText(buffer);

    // Layer 2: contextual patterns in stripped text
    if (!planName) {
      planName = this.extractFromContext(buffer);
    }

    if (this.debug && rawData.length > 0) {
      const stripped = this.stripAnsi(rawData);
      if (stripped.trim().length > 0) {
        console.log(`[PlanDetector] session=${sessionId} chunk(${rawData.length}b) stripped="${stripped.slice(0, 200)}" match=${planName || 'none'}`);
      }
    }

    if (planName) {
      const prev = this.detectedPlans.get(sessionId);
      if (prev === planName) return; // deduplicate

      if (this.debug) {
        console.log(`[PlanDetector] session=${sessionId} DETECTED plan="${planName}"`);
      }

      this.detectedPlans.set(sessionId, planName);
      this.callback?.(sessionId, planName);
    }
  }

  markUserRenamed(sessionId: string): void {
    this.userRenamed.set(sessionId, true);
  }

  getDetectedPlan(sessionId: string): string | undefined {
    return this.detectedPlans.get(sessionId);
  }

  dispose(): void {
    this.buffers.clear();
    this.detectedPlans.clear();
    this.userRenamed.clear();
    this.callback = null;
  }

  private extractFromColoredText(data: string): string | null {
    let match: RegExpExecArray | null;

    // Standard blue: \x1b[34m
    const stdRe = /\x1b\[34m([^\x1b]+)/g;
    while ((match = stdRe.exec(data)) !== null) {
      const found = this.matchPlanName(match[1]);
      if (found) return found;
    }

    // 256-color blue: \x1b[38;5;Nm
    const ext256Re = /\x1b\[38;5;(\d+)m([^\x1b]+)/g;
    while ((match = ext256Re.exec(data)) !== null) {
      const colorCode = parseInt(match[1], 10);
      if (!BLUE_256_CODES.has(colorCode)) continue;
      const found = this.matchPlanName(match[2]);
      if (found) return found;
    }

    // Truecolor blue: \x1b[38;2;R;G;Bm where B > R and B > G (blue-dominant)
    const truecolorRe = /\x1b\[38;2;(\d+);(\d+);(\d+)m([^\x1b]+)/g;
    while ((match = truecolorRe.exec(data)) !== null) {
      const r = parseInt(match[1], 10);
      const g = parseInt(match[2], 10);
      const b = parseInt(match[3], 10);
      // Accept blue-dominant colors (blue channel is highest, and at least 150)
      if (b >= 150 && b > r && b > g) {
        const found = this.matchPlanName(match[4]);
        if (found) return found;
      }
    }

    return null;
  }

  private matchPlanName(text: string): string | null {
    const trimmed = text.trim();
    if (PLAN_NAME_EXACT.test(trimmed)) return trimmed;
    const inner = PLAN_NAME_RE.exec(trimmed);
    if (inner && PLAN_NAME_EXACT.test(inner[0])) return inner[0];
    return null;
  }

  private extractFromContext(data: string): string | null {
    const stripped = this.stripAnsi(data);

    // Plan file path: plans/plan-name.md
    const pathMatch = /plans[/\\]([a-z]+-[a-z]+(?:-[a-z]+){0,3})\.md/.exec(stripped);
    if (pathMatch) return pathMatch[1];

    // "Plan: plan-name" or "plan: plan-name"
    const labelMatch = /[Pp]lan[:\s]+([a-z]+-[a-z]+(?:-[a-z]+){0,3})/.exec(stripped);
    if (labelMatch) return labelMatch[1];

    return null;
  }

  private stripAnsi(text: string): string {
    return text.replace(ANSI_RE, '');
  }
}

export const planDetector = new PlanDetector();
