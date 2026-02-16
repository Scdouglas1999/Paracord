-- Ensure default Member (@everyone-equivalent) roles can stream by default.
--
-- STREAM bit: 1 << 9 = 512
-- CONNECT bit: 1 << 20 = 1,048,576
-- SPEAK bit: 1 << 21 = 2,097,152
--
-- We scope this to the default role for each space (id = space_id) and only
-- where CONNECT+SPEAK are already present.
UPDATE roles
SET permissions = permissions | 512
WHERE id = space_id
  AND (permissions & 1048576) != 0
  AND (permissions & 2097152) != 0
  AND (permissions & 512) = 0;
