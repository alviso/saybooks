-- crm 0.5: whether the event happens is the organiser's business; whether you go is yours.
-- Most events on this calendar were found by the research agent, not scheduled by the person,
-- so reschedule and cancel are the wrong verbs for them. Attendance is the person's stance,
-- and it is a separate axis from the event's own status (CRM-22).
ALTER TABLE crm_event ADD COLUMN attendance TEXT;        -- NULL (undecided) | skip | attending | registered | went
ALTER TABLE crm_event ADD COLUMN attendance_at TEXT;
