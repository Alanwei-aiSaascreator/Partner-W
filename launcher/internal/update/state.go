package update

import (
	"encoding/json"
	"fmt"
	"path/filepath"
)

func StatePath(transaction TransactionV1) string {
	return filepath.Join(transaction.UpdateRoot, StateFileName)
}

func ReadTransactionWith(ops Ops, path string) (TransactionV1, error) {
	data, err := ops.ReadFile(path)
	if err != nil {
		return TransactionV1{}, fmt.Errorf("%w: %v", ErrInvalidTransaction, err)
	}
	return DecodeTransaction(data)
}

func DecodeTransaction(data []byte) (TransactionV1, error) {
	var transaction TransactionV1
	if err := decodeStrict(data, &transaction); err != nil {
		return TransactionV1{}, fmt.Errorf("%w: %v", ErrInvalidTransaction, err)
	}
	if transaction.SchemaVersion != SchemaVersion {
		return TransactionV1{}, fmt.Errorf("%w: unsupported schema version %d", ErrInvalidTransaction, transaction.SchemaVersion)
	}
	if err := ValidateTransactionPaths(transaction); err != nil {
		return TransactionV1{}, err
	}
	return transaction, nil
}

func WriteTransaction(ops Ops, transaction TransactionV1) (TransactionV1, error) {
	if err := ValidateTransactionPaths(transaction); err != nil {
		return TransactionV1{}, err
	}
	stamped := transaction
	floor := transaction.UpdatedAt
	if existing, err := ReadTransactionWith(ops, StatePath(transaction)); err == nil {
		floor = maxInt64(floor, existing.UpdatedAt)
	}
	stamped.UpdatedAt = maxInt64(ops.Now().UnixMilli(), floor+1)
	data, err := json.Marshal(stamped)
	if err != nil {
		return TransactionV1{}, err
	}
	path := StatePath(stamped)
	temporaryPath := path + ".tmp"
	if err := ops.WriteFile(temporaryPath, data, 0o600); err != nil {
		return TransactionV1{}, err
	}
	if err := ops.Rename(temporaryPath, path); err != nil {
		return TransactionV1{}, err
	}
	return stamped, nil
}

func ReadHealthReceipt(ops Ops, path string) (HealthReceiptV1, error) {
	data, err := ops.ReadFile(path)
	if err != nil {
		return HealthReceiptV1{}, err
	}
	var receipt HealthReceiptV1
	if err := decodeStrict(data, &receipt); err != nil {
		return HealthReceiptV1{}, err
	}
	if receipt.SchemaVersion != SchemaVersion {
		return HealthReceiptV1{}, fmt.Errorf("%w: unsupported health schema %d", ErrInvalidTransaction, receipt.SchemaVersion)
	}
	return receipt, nil
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
