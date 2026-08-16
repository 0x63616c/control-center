ALTER TABLE domain_event
ADD CONSTRAINT domain_event_last_error_code_check CHECK (
  last_error_code IS NULL OR last_error_code IN (
    'temporal_unavailable',
    'unsupported_event_version',
    'capability_not_registered',
    'dispatch_unexpected'
  )
);
