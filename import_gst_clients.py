import os
import sys
from pymongo import MongoClient
from dotenv import dotenv_values

def main():
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
        print("Usage: python import_gst_clients.py <path_to_excel_file>")
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
    name_col = next((c for c in df.columns if 'dealer name' in c.lower() or 'client name' in c.lower() or 'name' in c.lower()), None)
    if not name_col:
        print("Error: Excel file must contain a 'Dealer Name' or 'Name' column.")
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
    
    # Helper for cleaning string values
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
    def get_col_val(row, search_names):
        if isinstance(search_names, str):
            search_names = [search_names]
        
        def normalize(s):
            return ' '.join(str(s).lower().replace('-', ' ').replace('/', ' ').replace('_', ' ').replace('.', ' ').split())
            
        for search_name in search_names:
            target = normalize(search_name)
            matched_col = next((c for c in df.columns if normalize(c) == target), None)
            if matched_col:
                return clean_val(row[matched_col])
        return ''

    for idx, row in df.iterrows():
        dealer_name = get_col_val(row, ['Dealer Name', 'Name'])
        if not dealer_name:
            continue
            
        gst_username = get_col_val(row, ['GST User Name', 'GST Username'])
        gst_password = get_col_val(row, ['GST Password'])
        gst_number = get_col_val(row, ['GST Number', 'GST No']).upper()
        staff = get_col_val(row, ['Staff', 'Operator']).lower()
        mobile_no = get_col_val(row, ['Mobile No', 'Mobile Number', 'Phone'])
        contact_person = get_col_val(row, ['Contact Person'])
        email_id = get_col_val(row, ['E-Mail ID', 'Email', 'Email ID'])
        
        # Calculate PAN from GST Number
        pan = ''
        if len(gst_number) >= 12:
            # First 2 digits is state code, next 10 characters are the PAN
            pan = gst_number[2:12].upper()
            
        # Determine GST Type (composition or normal)
        is_cmp = '- gstr 4' in dealer_name.lower()
        gst_type = 'cmp' if is_cmp else ('normal' if gst_number else '')
        
        # Search for existing client by PAN
        existing = None
        if pan:
            existing = clients_col.find_one({'pan': pan})
            
        if not existing:
            # Fallback to name search
            existing = clients_col.find_one({'name': {'$regex': f'^{dealer_name}$', '$options': 'i'}})
            
        try:
            if existing:
                # Append/update GST info to existing client
                clients_col.update_one(
                    {'_id': existing['_id']},
                    {
                        '$set': {
                            'gstUsername': gst_username,
                            'gstPassword': gst_password,
                            'gstNumber': gst_number,
                            'gstStaff': staff,
                            'gstMobileNo': mobile_no,
                            'gstContactPerson': contact_person,
                            'gstEmail': email_id,
                            'gstType': gst_type
                        }
                    }
                )
                update_count += 1
            else:
                # Create a new case
                current_max_id += 1
                new_client = {
                    'id': current_max_id,
                    'name': dealer_name,
                    'pan': pan,
                    'contact': mobile_no, # Also populate general phone
                    'email': email_id,     # Also populate general email
                    'gstUsername': gst_username,
                    'gstPassword': gst_password,
                    'gstNumber': gst_number,
                    'gstStaff': staff,
                    'gstMobileNo': mobile_no,
                    'gstContactPerson': contact_person,
                    'gstEmail': email_id,
                    'gstType': gst_type,
                    'dob': '',
                    'address': '',
                    'area': '',
                    'city': '',
                    'pinCode': '',
                    'aadhaar': '',
                    'status': 'Individual',
                    'taxAuditCase': 'No',
                    'passwordITR': ''
                }
                clients_col.insert_one(new_client)
                insert_count += 1
            success_count += 1
        except Exception as e:
            print(f"Error processing row {idx + 2} ({dealer_name}): {e}")
            
    print("\nGST Clients Database Import Completed Successfully!")
    print(f"Total Rows Processed: {success_count}")
    print(f"New Inserted: {insert_count}")
    print(f"Updated Existing (Merged): {update_count}")

if __name__ == '__main__':
    main()
