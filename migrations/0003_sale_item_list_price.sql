-- Historical catalog prices are unknown: keep existing rows NULL, without backfilling.
-- New sales capture this snapshot from products inside the sale's atomic batch.
ALTER TABLE sale_items ADD COLUMN list_unit_price_kurus INTEGER
    CHECK (list_unit_price_kurus IS NULL OR (
        typeof(list_unit_price_kurus) = 'integer'
        AND list_unit_price_kurus >= 0
        AND list_unit_price_kurus <= 9007199254740991
    ));
