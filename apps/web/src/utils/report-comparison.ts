import type { Report } from '@scova/models';
import { reportSections } from '@/composables/useReport';
import { changeSummary, mapReportChanges } from '@/utils/report-changes';

/** Compose existing readonly projections; the server remains the owner of comparison decisions. */
export function reportComparison(report: Report) {
    return {
        groups: mapReportChanges(report),
        summary: changeSummary(report),
        sections: reportSections(report),
    };
}
