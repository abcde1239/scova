import { relations } from 'drizzle-orm';
import { bookmarks, notes } from '../library.ts';
import { users } from '../identity.ts';
import { sources } from '../sources.ts';
import { reports } from '../reports.ts';

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Bookmark',
        fields: [bookmarks.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'Bookmark_source',
        fields: [bookmarks.userId, bookmarks.sourceId],
        references: [sources.userId, sources.id],
    }),
}));

export const notesRelations = relations(notes, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Note',
        fields: [notes.userId],
        references: [users.id],
    }),
    source: one(sources, {
        relationName: 'Note_source',
        fields: [notes.userId, notes.sourceId],
        references: [sources.userId, sources.id],
    }),
    report: one(reports, {
        relationName: 'Note_report',
        fields: [notes.userId, notes.reportId],
        references: [reports.userId, reports.id],
    }),
}));
