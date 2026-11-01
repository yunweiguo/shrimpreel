-- 第二角色照片可为空：旧任务和单人分饰两角沿用 upload_id。
ALTER TABLE generations ADD COLUMN secondary_upload_id TEXT REFERENCES uploads(id);
CREATE INDEX idx_generations_secondary_upload ON generations(secondary_upload_id);
