CREATE TABLE scova_checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    checkpoint BLOB NOT NULL,
    metadata BLOB NOT NULL,
    parent_id TEXT,
    PRIMARY KEY (thread_id, checkpoint_id)
) STRICT;

CREATE TABLE scova_checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    write_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    value BLOB NOT NULL,
    task_path TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_id, write_key)
) STRICT;
