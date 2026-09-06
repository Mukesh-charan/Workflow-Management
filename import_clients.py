import os
import sys
from pymongo import MongoClient
from dotenv import dotenv_values

def main():
    # Inform user about dependencies
    try:
        import pandas as pd
    except ImportError:
        print("Error: 'pandas' library is required to run this script.")
        print("Please install required libraries by running:")
        print("pip install pandas openpyxl pymongo dnspython python-dotenv")
        sys.exit(1)

    # Load env variables
    env_path = os.path.join(os.path.dirname(__file__), '.env.local')
    if not os.path.exists(env_path):
        print(f"Error: .env.local file not found at {env_path}")
        print("Please run this script from inside the smk-office-workflow folder.")
        sys.exit(1)
        
    config = dotenv_values(env_path)
    mongo_uri = config.get('MONGODB_URI')
    
    if not mongo_uri:
        print("Error: MONGODB_URI not found in .env.local.")
        sys.exit(1)
        
    if len(sys.argv) < 2:
        print("Usage: python import_clients.py <path_to_excel_file>")
        sys.exit(1)
        
    excel_path = sys.argv[1]
    if not os.path.exists(excel_path):
        print(f"Error: Excel file not found at {excel_path}")
        sys.exit(1)
        
    print(f"Reading Excel file: {excel_path}...")
    try:
        df = pd.read_excel(excel_path)
    except Exception as e:
        print(f"Error reading Excel file: {e}")
        print("Make sure you have installed 'openpyxl': pip install openpyxl")
        sys.exit(1)
        
    # Standardize columns by stripping spaces
    df.columns = [str(c).strip() for c in df.columns]
    
    # Check for required column
    if 'Name' not in df.columns:
        print("Error: The Excel spreadsheet must contain a column named 'Name'.")
        print(f"Available columns: {list(df.columns)}")
        sys.exit(1)
        
    # Connect to MongoDB
    print("Connecting to MongoDB Atlas...")
    try:
        client = MongoClient(mongo_uri)
        db = client['ca_office_workflow']
        clients_col = db['clients']
    except Exception as e:
        print(f"MongoDB connection error: {e}")
        sys.exit(1)
        
    # Get current max client ID
    try:
        max_client = list(clients_col.find({}).sort('id', -1).limit(1))
        current_max_id = max_client[0]['id'] if max_client else 1000
    except Exception as e:
        print(f"Error fetching client ID counter: {e}")
        sys.exit(1)
        
    print(f"Current maximum Client ID in database: {current_max_id}")
    
    success_count = 0
    update_count = 0
    insert_count = 0
    
    # Helper for cleaning string values (removing .0 for floats)
    def clean_val(val):
        if pd.isna(val):
            return ''
        s = str(val).strip()
        if s.lower() == 'nan':
            return ''
        if s.endswith('.0'):
            try:
                float(s)
                s = s[:-2]
            except ValueError:
                pass
        return s

    # Flexible column lookup
    def get_col_val(row, search_name):
        def normalize(s):
            return ' '.join(str(s).lower().replace('-', ' ').replace('/', ' ').replace('_', ' ').split())
        target = normalize(search_name)
        matched_col = next((c for c in df.columns if normalize(c) == target), None)
        if matched_col:
            val = row[matched_col]
            if isinstance(val, pd.Timestamp):
                return val.strftime('%Y-%m-%d')
            return clean_val(val)
        return ''

    # Normalization helper for DOB strings
    def normalize_dob(dob_val):
        import re
        if not dob_val:
            return ''
        s = str(dob_val).strip()
        if s.lower() == 'nan':
            return ''
        
        # Remove time string like " 00:00:00"
        s = re.sub(r'\s*\d{2}:\d{2}:\d{2}\s*', ' ', s)
        # Remove extra spaces around hyphens or slashes
        s = re.sub(r'\s*([-/])\s*', r'\1', s)
        s = s.strip()
        
        # YYYY-MM-DD
        if re.match(r'^\d{4}[-/]\d{2}[-/]\d{2}$', s):
            return s.replace('/', '-')
            
        # DD-MM-YYYY or DD/MM/YYYY
        match = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$', s)
        if match:
            dd, mm, yyyy = match.groups()
            return f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}"
            
        # Try pandas to_datetime
        try:
            dt = pd.to_datetime(s, errors='coerce')
            if pd.notna(dt):
                return dt.strftime('%Y-%m-%d')
        except Exception:
            pass
            
        return s

    for idx, row in df.iterrows():
        # Extrapolate details
        name = get_col_val(row, 'Name')
        if not name:
            continue
            
        pan = get_col_val(row, 'PAN').upper()
        mobile = get_col_val(row, 'Mobile Number')
        if not mobile:
            mobile = get_col_val(row, 'contact')
        if not mobile:
            mobile = get_col_val(row, 'phone')
            
        email = get_col_val(row, 'Email ID')
        if not email:
            email = get_col_val(row, 'email')
            
        password_itr = get_col_val(row, 'Password of Intimation/ ITR-V')
        tax_audit = get_col_val(row, 'Tax-audit case')
        dob = normalize_dob(get_col_val(row, 'DOB/DOI/DOF'))
        address = get_col_val(row, 'Address')
        area = get_col_val(row, 'Area / Locality')
        city = get_col_val(row, 'City')
        pin = get_col_val(row, 'PIN / ZIP code')
        aadhaar = get_col_val(row, 'Aadhaar No.')
        status = get_col_val(row, 'Status')
            
        # Search for existing client
        existing = None
        if pan:
            existing = clients_col.find_one({'pan': pan})
            
        if not existing:
            # Case insensitive exact name search
            existing = clients_col.find_one({'name': {'$regex': f'^{name}$', '$options': 'i'}})
            
        client_data = {
            'name': name,
            'pan': pan,
            'contact': mobile,
            'email': email,
            'passwordITR': password_itr,
            'taxAuditCase': tax_audit,
            'dob': dob,
            'address': address,
            'area': area,
            'city': city,
            'pinCode': pin,
            'aadhaar': aadhaar,
            'status': status
        }
        
        try:
            if existing:
                clients_col.update_one({'_id': existing['_id']}, {'$set': client_data})
                update_count += 1
            else:
                current_max_id += 1
                client_data['id'] = current_max_id
                clients_col.insert_one(client_data)
                insert_count += 1
            success_count += 1
        except Exception as e:
            print(f"Error processing row {idx + 2} ({name}): {e}")
            
    print("\nDatabase synchronization completed successfully!")
    print(f"Processed: {success_count} clients.")
    print(f"New Inserted: {insert_count}")
    print(f"Updated Existing: {update_count}")

if __name__ == '__main__':
    main()
